import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import { narrowStructuredLaunchSeedOptions } from '../../../../../../shared/native-chat-session-option-defaults'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../../shared/orchestration-task-display'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { TaskRow } from '../../../../orchestration/types'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { createStructuredWorkerSession } from '../../orchestration-structured-worker-session'

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
  executionHostId?: ExecutionHostId
  worktreeInstanceId?: string
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

export function resolveWorkerTerminalTitle(
  task: Pick<TaskRow, 'spec' | 'task_title' | 'display_name'>,
  customTitle?: string | null
): string {
  if (customTitle?.trim()) {
    return customTitle.trim()
  }
  const display = buildOrchestrationTaskDisplayMetadata({
    spec: task.spec,
    taskTitle: task.task_title,
    displayName: task.display_name
  })
  return display.displayName || display.taskTitle || 'Untitled task'
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
  worktreeId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  taskId: string
  effects: WorkerEffect[]
}): Promise<{ handle: string; warning?: string }> {
  const task = args.runtime.getOrchestrationDb().getTask(args.taskId)
  const terminal = await args.runtime.createTerminal(`id:${args.worktreeId}`, {
    // Why: the agent id is not a shell command — `cursor` resolves to the Cursor
    // desktop app while its CLI is `cursor-agent`. Let the runtime build the
    // configured launcher instead of executing the raw id.
    startupAgent: args.agent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    title: task ? resolveWorkerTerminalTitle(task) : 'Untitled task',
    // Why: dispatching a worker is background work; it must not pull the sidebar
    // to the worker's workspace while the user is reading somewhere else.
    surfaceOwner: false,
    // Why: this terminal IS the orchestration-managed worker's agent process —
    // the explicit typed signal that injects the bounded ManagedCliContext
    // before spawn. Never set on a manual agent terminal.
    orchestrationManagedLaunch: true
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

export async function createStructuredWorkerSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  worktreeId: string
  agent: TuiAgent
  dispatchId: string
  launchPreferences?: AgentLaunchPreferences
  effects: WorkerEffect[]
}): Promise<Awaited<ReturnType<typeof createStructuredWorkerSession>>> {
  if (args.agent !== 'claude' && args.agent !== 'codex') {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Structured workers support claude and codex; ${args.agent} has no structured session.`
    )
  }
  const options = narrowStructuredLaunchSeedOptions(args.launchPreferences)
  const created = await createStructuredWorkerSession({
    runtime: args.runtime,
    worktreeId: args.worktreeId,
    agent: args.agent,
    dispatchId: args.dispatchId,
    ...(options ? { options } : {}),
    onJournalActivity: (sessionId) =>
      args.runtime.notifyStructuredSessionJournalActivity?.(sessionId)
  })
  args.effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: created.identity.handle,
    surface: 'background'
  })
  return created
}

export function applyWaitForSetupOutcome(
  receipt: WorkerSetupReceipt,
  effects: WorkerEffect[],
  wait: { satisfied: boolean; status: string }
): void {
  if (receipt.startupPolicy !== 'wait-for-setup' || receipt.state !== 'running') {
    return
  }
  if (wait.satisfied) {
    receipt.state = 'succeeded'
  } else if (wait.status === 'exited') {
    receipt.state = 'failed'
  } else {
    return
  }
  const setupEffect = effects.find((effect) => effect.kind === 'setup')
  if (setupEffect) {
    setupEffect.state = receipt.state
  }
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
    from: string
  }
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  effects: WorkerEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
  setupReceipt: WorkerSetupReceipt
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  const dispatch = db.getDispatchContextById(dispatchId)
  const task = dispatch ? db.getTask(dispatch.task_id) : undefined
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
    startupAgent: args.agent,
    ...(task ? { startupTerminalTitle: resolveWorkerTerminalTitle(task) } : {}),
    ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {}),
    activate: false,
    // Why: the worktree's startup terminal IS the orchestration-managed
    // worker's agent process — thread the same explicit typed signal
    // createTerminal expects through to its actual spawn boundary.
    orchestrationManagedLaunch: true,
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
    id: created.worktree.id,
    ...(created.worktree.hostId ? { executionHostId: created.worktree.hostId } : {}),
    ...(created.worktree.instanceId ? { worktreeInstanceId: created.worktree.instanceId } : {})
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
  if (!terminalHandle) {
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
      action: terminal.handle === terminalHandle ? 'reused_agent_terminal' : 'created',
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
