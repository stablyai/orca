import { isDeepStrictEqual } from 'node:util'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { getAutomationWorkspaceRecoveryTarget } from '../../shared/automation-workspace-recovery-target'
import type { Store } from '../persistence'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'

export type RunnableAutomationTarget = Extract<AutomationRunTargetResult, { ok: true }>
export type AutomationWorkspace = { id: string; displayName: string }
export type AutomationWorkspaceProbe =
  | { kind: 'available'; workspace: AutomationWorkspace }
  | { kind: 'missing' }
  | {
      kind: 'unverifiable'
      error: string
      status?: 'skipped_unavailable' | 'skipped_needs_interactive_auth'
    }

export type AutomationWorkspaceOperations = {
  probe(automation: Automation, target: RunnableAutomationTarget): Promise<AutomationWorkspaceProbe>
  create(
    automation: Automation,
    run: AutomationRun,
    target: RunnableAutomationTarget
  ): Promise<AutomationWorkspace>
}

export function automationDefinition(automation: Automation) {
  const { lastRunAt: _last, updatedAt: _updated, nextRunAt: _next, ...configured } = automation
  return configured
}

type Replacement = { automation: Automation; workspace: AutomationWorkspace }
type PreparedWorkspace = {
  automation: Automation
  target: RunnableAutomationTarget
}

export class AutomationWorkspaceRecovery {
  private readonly replacements = new Map<
    string,
    { definition: ReturnType<typeof automationDefinition>; result: Promise<Replacement> }
  >()

  constructor(
    private readonly operations: AutomationWorkspaceOperations,
    private readonly store: Pick<
      Store,
      'updateAutomation' | 'automationOwnerPrecondition' | 'flushPendingOrThrowAsync'
    >,
    private readonly publishDefinition: (automationId: string) => void
  ) {}

  async resolve(
    automation: Automation,
    target: RunnableAutomationTarget
  ): Promise<AutomationRunTargetResult> {
    if (automation.workspaceMode !== 'existing') {
      return target
    }
    let probe: AutomationWorkspaceProbe
    try {
      probe = await this.operations.probe(automation, target)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (probe.kind === 'unverifiable') {
      return { ok: false, error: probe.error, ...(probe.status ? { status: probe.status } : {}) }
    }
    if (probe.kind === 'missing' && !getAutomationWorkspaceRecoveryTarget(automation)) {
      return { ok: false, error: 'The target workspace is no longer available.' }
    }
    return { ...target, workspace: probe.kind === 'available' ? probe.workspace : null }
  }

  async prepare(
    automation: Automation,
    run: AutomationRun,
    target: RunnableAutomationTarget,
    assertCurrent: () => Promise<RunnableAutomationTarget>
  ): Promise<PreparedWorkspace> {
    if (automation.workspaceMode !== 'existing' || target.workspace !== null) {
      return { automation, target }
    }
    const expected = structuredClone(automationDefinition(automation))
    const active = this.replacements.get(automation.id)
    if (active && !isDeepStrictEqual(active.definition, expected)) {
      throw new Error('The automation changed while its workspace was being replaced.')
    }
    const result = active?.result ?? this.replace(automation, run, target, assertCurrent)
    if (!active) {
      this.replacements.set(automation.id, { definition: expected, result })
    }
    let replacement: Replacement
    try {
      replacement = await result
    } finally {
      if (this.replacements.get(automation.id)?.result === result) {
        this.replacements.delete(automation.id)
      }
    }
    const { automation: updated, workspace } = replacement
    const cwd = updated.runContext
      ? target.cwd
      : (splitWorktreeIdForFilesystem(updated.workspaceId ?? '')?.worktreePath ?? target.cwd)
    return { automation: updated, target: { ...target, cwd, workspace } }
  }

  private async replace(
    automation: Automation,
    run: AutomationRun,
    target: RunnableAutomationTarget,
    assertCurrent: () => Promise<RunnableAutomationTarget>
  ): Promise<Replacement> {
    const expectedOwner = this.store.automationOwnerPrecondition(automation.id) ?? undefined
    const before = await assertCurrent()
    if (before.workspace) {
      return { automation, workspace: before.workspace }
    }
    const workspace = await this.operations.create(automation, run, target)
    const after = await assertCurrent()
    if (after.workspace) {
      return { automation, workspace: after.workspace }
    }
    const updated = this.store.updateAutomation(
      automation.id,
      { workspaceId: workspace.id },
      { expectedOwner }
    )
    // The replacement must survive a restart before an agent can use it.
    await this.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    this.publishDefinition(updated.id)
    return { automation: updated, workspace }
  }
}
