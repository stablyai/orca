import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { waitForWorkerSetupGate } from './orchestration-worker-setup-gate'

export type WorkerEffect = {
  kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'
  action?: string
  role?: string
  id?: string
  state?: string
  tabId?: string
  leafId?: string
  requested?: string
  effective?: string
  source?: string
  hookFound?: boolean
  startupPolicy?: string
  terminalId?: string
  surface?: 'visible' | 'background'
  warning?: string
}

export type WorkerSetupReceipt = {
  requested: 'run' | 'skip' | 'inherit' | 'not_applicable'
  effective: 'run' | 'skip' | 'inherit' | 'not_applicable'
  source: string
  hookFound: boolean
  startupPolicy: 'start-immediately' | 'wait-for-setup'
  state:
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'not_configured'
    | 'spawn_failed'
    | 'not_applicable'
}

export function requireWorkerAuthority(runtime: OrcaRuntimeService, terminalHandle: string) {
  const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
  const paneKey = authority?.paneKey ?? runtime.getTerminalPaneKey(terminalHandle)
  const processIncarnation =
    authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(terminalHandle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  return {
    paneKey,
    processIncarnation,
    ...(authority?.launchTokenHash ? { launchTokenHash: authority.launchTokenHash } : {}),
    ...(authority?.hostScope ? { hostScope: JSON.stringify(authority.hostScope) } : {})
  }
}

export async function createExistingWorktreeWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  deadlineAt: string
  maxRequests: number
  taskId: string
  effects: WorkerEffect[]
}): Promise<{ handle: string; warning?: string }> {
  if (Date.parse(args.deadlineAt) <= Date.now()) {
    throw new Error('runtime_budget_exhausted')
  }
  const sentinelPath = args.runtime.getWorkerWatchdogSentinelPath(args.dispatchId)
  args.db.setWorkerWatchdogSentinelPath(args.dispatchId, sentinelPath)
  const terminal = await args.runtime.createBoundedWorkerTerminal(`id:${args.worktreeId}`, {
    dispatchId: args.dispatchId,
    agent: args.agent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    deadlineAt: args.deadlineAt,
    maxRequests: args.maxRequests,
    title: `worker-${args.taskId}`,
    // Why: dispatching a worker is background work; it must not pull the sidebar
    // to the worker's workspace while the user is reading somewhere else.
    surfaceOwner: false
  })
  args.db.recordStartingWorkerTerminalResource({
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    terminalHandle: terminal.handle
  })
  args.effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning
  })
  return { handle: terminal.handle, warning: terminal.warning }
}

export async function createWorkerWorktree(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  requestedWorktree: string
  coordinatorWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  params: {
    repo?: string
    name?: string
    baseBranch?: string
    displayName?: string
    comment?: string
    setup?: 'run' | 'skip' | 'inherit'
    timeoutMs?: number
    from: string
  }
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  deadlineAt: string
  maxRequests: number
  effects: WorkerEffect[]
  onStage?: (stage: 'terminal_create') => void
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
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
    comment: params.comment,
    // setupDecision runs setup without the legacy runHooks activation side effect.
    runHooks: false,
    setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    createdWithAgent: args.agent,
    activate: false,
    lineage: {
      parentWorktree: requestedWorktree === 'new-child' ? coordinatorWorktree.id : undefined,
      noParent: requestedWorktree === 'new-top-level',
      callerTerminalHandle: params.from
    }
  })
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
  const setupReceipt: WorkerSetupReceipt = {
    requested: setupDecision,
    effective: setupDecision,
    source: params.setup ? 'explicit_request' : 'orchestration_default',
    hookFound: created.setupReceipt?.hookFound ?? false,
    startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
    state: created.setupReceipt?.state ?? 'not_configured'
  }
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
  const setupTerminalHandle = created.setupReceipt?.terminalHandle
  for (const listedTerminal of listed.terminals) {
    effects.push({
      kind: 'terminal',
      role: listedTerminal.handle === setupTerminalHandle ? 'setup' : 'configured_tab',
      action: 'created',
      id: listedTerminal.handle,
      tabId: listedTerminal.tabId,
      leafId: listedTerminal.leafId
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
  await waitForWorkerSetupGate({
    runtime,
    db,
    dispatchId,
    worktreeId: created.worktree.id,
    deadlineAt: args.deadlineAt,
    timeoutMs: params.timeoutMs,
    setupTerminalHandle,
    setupReceipt,
    effects
  })
  if (Date.parse(args.deadlineAt) <= Date.now()) {
    throw new Error('runtime_budget_exhausted')
  }
  args.onStage?.('terminal_create')
  db.recordWorkerStage({
    dispatchId,
    stage: 'setup_observed',
    worktreeId: created.worktree.id,
    setupState: setupReceipt.state,
    effects,
    residualResources: effects
  })
  const sentinelPath = runtime.getWorkerWatchdogSentinelPath(dispatchId)
  db.setWorkerWatchdogSentinelPath(dispatchId, sentinelPath)
  const terminal = await runtime.createBoundedWorkerTerminal(`id:${created.worktree.id}`, {
    dispatchId,
    agent: args.agent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    deadlineAt: args.deadlineAt,
    maxRequests: args.maxRequests,
    title: `worker-${dispatchId}`,
    surfaceOwner: false
  })
  const terminalHandle = terminal.handle
  db.recordStartingWorkerTerminalResource({
    dispatchId,
    worktreeId: created.worktree.id,
    terminalHandle: terminal.handle
  })
  effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning
  })
  return {
    worktree: created.worktree as Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
    terminalHandle,
    setupReceipt
  }
}

export function isUnknownWorkerStartOutcome(error: unknown, stage: string): boolean {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (code === 'operation_unknown') {
    return true
  }
  if (stage !== 'worktree_create') {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection|disconnect|timed?\s*out|runtime changed|outcome unknown/i.test(message)
}
