/** Create PTY worktrees agent-first; structured workers create sessions afterwards without startup agents. Setup/default tabs/lineage stay identical. */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

export async function createWorkerWorktree(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  requestedWorktree: string
  coordinatorWorktree: Pick<
    Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
    'id' | 'repoId'
  >
  params: {
    repo?: string
    name?: string
    baseBranch?: string
    displayName?: string
    comment?: string
    setup?: 'run' | 'skip' | 'inherit'
    from: string
  }
  agent: TuiAgent
  /** Structured creation skips startup agent and TUI trust presets: no PTY menu can consume its first paste. Setup/default tabs still run, matching renderer chat creates. */
  withAgentTerminal: boolean
  promisedAgentChat?: boolean
  onWorkspaceCreated?: (worktreeId: string) => void
  launchPreferences?: AgentLaunchPreferences
  effects: WorkerEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string | undefined
  setupReceipt: WorkerSetupReceipt
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  db.recordWorkerStage({ dispatchId, stage: 'worktree_creating', effects })
  const created = await runtime.createManagedWorktree({
    repoSelector: params.repo ?? coordinatorWorktree.repoId,
    name: params.name as string,
    baseBranch: params.baseBranch,
    displayName: params.displayName,
    ...(params.displayName !== undefined ? { displayNameKind: 'user' as const } : {}),
    comment: params.comment,
    // setupDecision runs setup without the legacy runHooks activation side effect.
    runHooks: false,
    setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    createdWithAgent: args.agent,
    ...(args.promisedAgentChat ? { promisedAgentChat: true } : {}),
    ...(args.onWorkspaceCreated ? { onWorkspaceCreated: args.onWorkspaceCreated } : {}),
    ...(args.withAgentTerminal
      ? {
          startupAgent: args.agent,
          startupLaunchSource: 'orchestration',
          startupSuppressUpdatePrompt: true,
          ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {})
        }
      : {}),
    activate: false,
    lineage: {
      parentWorktree: requestedWorktree === 'new-child' ? coordinatorWorktree.id : undefined,
      noParent: requestedWorktree === 'new-top-level',
      callerTerminalHandle: params.from
    }
  })
  const terminalHandle = created.startupTerminal?.handle
  effects.push({
    kind: 'worktree',
    action: requestedWorktree === 'new-child' ? 'created_child' : 'created_top_level',
    id: created.worktree.id
  })
  db.recordWorkerStage({
    dispatchId,
    stage: 'worktree_created',
    worktreeId: created.worktree.id,
    effects,
    residualResources: effects
  })
  const setupReceipt = {
    requested: setupDecision,
    effective: setupDecision,
    source: params.setup ? 'explicit_request' : 'orchestration_default',
    hookFound: created.setupReceipt?.hookFound ?? false,
    startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
    state: created.setupReceipt?.state ?? 'not_configured'
  }
  if (args.withAgentTerminal && !terminalHandle) {
    throw new Error(created.warning ?? 'Agent-first worktree creation returned no terminal.')
  }
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
  const setupTerminalHandle = created.setupReceipt?.terminalHandle
  for (const terminal of listed.terminals) {
    effects.push({
      kind: 'terminal',
      role:
        terminal.handle === terminalHandle
          ? 'agent'
          : terminal.handle === setupTerminalHandle
            ? 'setup'
            : 'configured_tab',
      // Agent-first creation made every listed terminal; reused_agent_terminal incorrectly mixed role with lifecycle.
      action: 'created',
      id: terminal.handle,
      tabId: terminal.tabId,
      leafId: terminal.leafId
    })
  }
  const setupTerminal = effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup'
  )
  effects.push({
    kind: 'setup',
    action: setupDecision,
    requested: setupReceipt.requested,
    effective: setupReceipt.effective,
    source: setupReceipt.source,
    hookFound: setupReceipt.hookFound,
    startupPolicy: setupReceipt.startupPolicy,
    state: setupReceipt.state,
    terminalId: setupTerminalHandle ?? setupTerminal?.id
  })
  return {
    worktree: created.worktree as Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
    terminalHandle,
    setupReceipt
  }
}
