import {
  recoveryBindingKeyOf,
  recoveryBindingKeyString,
  type RecoveryBindingKey
} from '../../../shared/cross-machine-recovery-binding-key'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryImportResult,
  RecoveryProvenance
} from '../../../shared/cross-machine-recovery-descriptor'
import { findRecoveryRecord } from '../../../shared/cross-machine-recovery-session-ops'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  localRecoveryBindingKey,
  planRecoveryBindings,
  sourceProviderSessionId,
  type PlannedRecoveryBinding,
  type RecoveryPlanContext
} from './recovery-import-plan'
import { resumeSelectedRecoveryBindings } from './recovery-resume'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

export type RecoveryReplayInput = {
  descriptor: OrcaRecoveryDescriptorV1
  ctx: RecoveryPlanContext
  resumeKeys: ReadonlySet<string>
  base: Pick<RecoveryImportResult, 'importKey' | 'repoId' | 'worktreeId' | 'instanceId'>
  provenance: RecoveryProvenance
  dryRun: boolean
}

/** True when every sleeping record in the worktree is a dormant row of this same import. */
export function holdsOnlyRecoveryImport(
  session: WorkspaceSessionState,
  worktreeId: string,
  importKey: string
): boolean {
  const records = Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
    (record) => record.worktreeId === worktreeId
  )
  return (
    records.length > 0 &&
    records.every(
      (record) => record.origin === 'recovery' && record.recovery?.importKey === importKey
    )
  )
}

/** Merges only bindings this host has neither live, mid-resume, nor already consumed; layout is untouched. */
export async function replayRecoveryImport(
  host: CrossMachineRecoveryHost,
  { descriptor, ctx, resumeKeys, base, provenance, dryRun }: RecoveryReplayInput
): Promise<RecoveryImportResult> {
  const consumed = new Set(provenance.consumedBindings ?? [])
  const blockedReason = (key: RecoveryBindingKey): string | null => {
    if (host.isProviderSessionLive(key) || host.resumeHolds.isHeld(key)) {
      return 'recovery_session_live_locally'
    }
    return consumed.has(recoveryBindingKeyString(key)) ? 'recovery_binding_consumed' : null
  }
  const records = host.getLocalSession().sleepingAgentSessionsByPaneKey
  const fresh = descriptor.bindings.filter(
    (binding) =>
      !findRecoveryRecord(records, ctx.worktreeId, localRecoveryBindingKey(binding, ctx.pathMap))
  )
  const emptyIdMap = { tabs: {}, groups: {}, leaves: {}, browsers: {} }
  const freshPlans = new Map(
    planRecoveryBindings(fresh, { terminalLayoutsByTabId: {}, idMap: emptyIdMap }, ctx).map(
      (plan) => [recoveryBindingKeyString(recoveryBindingKeyOf(plan.binding)), plan]
    )
  )
  const planned = descriptor.bindings.map((binding): PlannedRecoveryBinding => {
    const localKey = localRecoveryBindingKey(binding, ctx.pathMap)
    const existing = findRecoveryRecord(records, ctx.worktreeId, localKey)
    const result = {
      sourcePaneKey: binding.sourcePaneKey,
      binding: localKey,
      sourceProviderSessionId: sourceProviderSessionId(binding, ctx),
      localPaneKey: existing?.paneKey ?? ''
    }
    if (existing) {
      return { binding, record: existing, result: { ...result, status: 'dormant' } }
    }
    const reason = blockedReason(localKey)
    if (reason) {
      return { binding, record: null, result: { ...result, status: 'refused', reason } }
    }
    const plan = freshPlans.get(recoveryBindingKeyString(recoveryBindingKeyOf(binding)))
    if (!plan) {
      throw new Error('recovery_binding_not_found')
    }
    return plan
  })
  if (!dryRun) {
    await host.applyOp({
      kind: 'merge-records',
      records: [...freshPlans.values()].flatMap((p) =>
        p.record && !blockedReason(recoveryBindingKeyOf(p.record)) ? [p.record] : []
      )
    })
  }
  return {
    ...base,
    disposition: 'replayed',
    presentationSource: provenance.presentationSource,
    idMap: emptyIdMap,
    bindings: dryRun
      ? planned.map((p) => p.result)
      : await resumeSelectedRecoveryBindings(host, ctx.worktreeId, planned, resumeKeys),
    provenance
  }
}
