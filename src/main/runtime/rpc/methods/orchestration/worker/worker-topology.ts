import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import { narrowStructuredLaunchSeedOptions } from '../../../../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createStructuredWorkerSession } from '../../orchestration-structured-worker-session'
import { dispatchReportMailbox } from '../../../../orchestration/dispatch-report-mailbox'

export type WorkerEffect = {
  kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'
  action?: string
  role?: string
  id?: string
  /** A created worktree's name, so the coordinator can tell the user where the worker runs. */
  name?: string
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
}): Promise<RuntimeTerminalCreate> {
  const terminal = await args.runtime.createTerminal(`id:${args.worktreeId}`, {
    // Resolve ids through agent config; cursor alone opens the desktop app, its CLI is cursor-agent.
    startupAgent: args.agent,
    launchSource: 'orchestration',
    suppressStartupUpdatePrompt: true,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    title: `worker-${args.taskId}`,
    // Worker creation is background work and must not pull the sidebar away.
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
  return terminal
}

/** Return structured workers in the terminal authority shape; registry-backed pane/incarnation getters keep requireWorkerAuthority mode-independent. */
export async function createStructuredWorkerSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  worktreeId: string
  agent: TuiAgent
  dispatchId: string
  /** `--model`/`--effort`; the session seeds them exactly as a saved selection is seeded. */
  launchPreferences?: AgentLaunchPreferences
  effects: WorkerEffect[]
}): Promise<Awaited<ReturnType<typeof createStructuredWorkerSession>>> {
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
      const dispatch = args.db.getDispatchContextById(args.dispatchId)
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: dispatch ? dispatchReportMailbox(args.db, dispatch) : `run:${args.runId}`,
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
