import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import { narrowStructuredLaunchSeedOptions } from '../../../../../../shared/native-chat-session-option-defaults'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
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
  worktreeId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  taskId: string
  effects: WorkerEffect[]
}): Promise<{ handle: string; warning?: string }> {
  const terminal = await args.runtime.createTerminal(`id:${args.worktreeId}`, {
    // Why: the agent id is not a shell command — `cursor` resolves to the Cursor
    // desktop app while its CLI is `cursor-agent`. Let the runtime build the
    // configured launcher instead of executing the raw id.
    startupAgent: args.agent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    title: `worker-${args.taskId}`,
    // Why: dispatching a worker is background work; it must not pull the sidebar
    // to the worker's workspace while the user is reading somewhere else.
    surfaceOwner: false
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

/**
 * A worker that IS a structured chat session, in the same shape the terminal path returns.
 *
 * `requireWorkerAuthority` needs no branch: the runtime's pane-key and process-incarnation getters
 * consult the structured registry, so the handle minted here answers exactly like a PTY handle.
 */
export async function createStructuredWorkerSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  worktreeId: string
  agent: TuiAgent
  dispatchId: string
  /** `--model`/`--effort`; the session seeds them exactly as a saved selection is seeded. */
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

export function monitorWorkerSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setupReceipt.startupPolicy !== 'start-immediately' ||
    args.setupReceipt.state !== 'running'
  ) {
    return
  }
  // Why: setup is intentionally non-gating, but command completion remains durable evidence.
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const evidence = args.db.updateWorkerSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects: args.effects.map((effect) =>
          effect.kind === 'setup' ? { ...effect, state: setupState } : effect
        )
      })
      if (!evidence.changed) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Setup ${setupState} for worker ${args.dispatchId}`,
        type: 'status',
        priority: setupState === 'failed' ? 'high' : 'normal',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          setupState,
          terminalHandle: setupTerminal.id
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
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
