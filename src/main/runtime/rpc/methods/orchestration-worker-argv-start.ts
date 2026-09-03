import { setTimeout as delay } from 'node:timers/promises'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import { persistGatedSetupSpawnFailure } from './orchestration-worker-setup-gate'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import {
  createArgvLaunchCredentials,
  persistArgvWorkerTerminalOwnership
} from './orchestration-worker-authority'

// Why: argv agents receive the preamble and launch token in the spawn command;
// binding proves the returned pane is the exact process with no paste race.
export async function startArgvWorkerDispatch(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: { id: string; spec: string }
  dispatchId: string
  coordinatorHandle: string
  devMode?: boolean
  timeoutMs: number
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  launchReceipt: OrchestrationWorkerLaunchReceipt
  worktreeId: string
  effects: WorkerEffect[]
  setupReceipt: WorkerSetupReceipt
  // Caller catch records the active failure stage.
  onStage: (stage: string) => void
}): Promise<Record<string, unknown>> {
  const { runtime, db, effects } = args
  const cliCommand = await runtime.getWorktreeOrchestrationCliCommand(args.worktreeId)
  const credentials = createArgvLaunchCredentials(args)
  const terminal = await runtime.createTerminal(`id:${args.worktreeId}`, {
    startupAgent: args.agent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    preAllocatedHandle: credentials.startupPreAllocatedHandle,
    launchToken: credentials.startupLaunchToken,
    agentPrompt: credentials.buildStartupPrompt(cliCommand),
    title: `worker-${args.task.id}`,
    // Background worker: do not pull the sidebar to its workspace.
    surfaceOwner: false
  })
  persistArgvWorkerTerminalOwnership({
    runtime,
    db,
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    terminal,
    setupReceipt: args.setupReceipt,
    effects
  })
  const setupStage = {
    db,
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    terminalHandle: terminal.handle,
    setup: args.setupReceipt,
    effects
  }
  args.onStage('authority_bind')
  // The preamble names preAllocatedHandle; a substituted handle is unsafe.
  if (terminal.handle !== credentials.startupPreAllocatedHandle) {
    throw new Error(
      `Worker terminal adopted handle ${terminal.handle} instead of the pre-allocated ${credentials.startupPreAllocatedHandle}.`
    )
  }
  if (persistGatedSetupSpawnFailure(setupStage)) {
    args.onStage('setup_start')
    throw new Error('Setup terminal failed to start before the gated agent launch.')
  }
  const boundAuthority = await requireWorkerAuthorityAfterSpawn(runtime, terminal.handle)
  db.bindStartingWorkerAuthority({
    dispatchId: args.dispatchId,
    handle: terminal.handle,
    ...boundAuthority,
    worktreeId: args.worktreeId,
    effects,
    setupState: args.setupReceipt.state,
    terminalOwnership: 'created'
  })
  // Bind before ready so fast completion cannot race a pending dispatch.
  effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: terminal.handle,
    state: 'accepted'
  })
  const worker = db.markWorkerDispatchReady(args.dispatchId, effects)
  monitorWorkerSetup({
    runtime,
    db,
    runId: args.runId,
    dispatchId: args.dispatchId,
    setupReceipt: args.setupReceipt,
    effects
  })
  monitorArgvStartupBlocked({
    runtime,
    db,
    runId: args.runId,
    dispatchId: args.dispatchId,
    terminalHandle: terminal.handle,
    timeoutMs: args.timeoutMs
  })
  return {
    runId: args.runId,
    taskId: args.task.id,
    dispatchId: args.dispatchId,
    state: worker.state,
    stage: worker.stage,
    setup: args.setupReceipt,
    launch: args.launchReceipt,
    timeoutMs: args.timeoutMs,
    effects,
    residualResources: [],
    ...(terminal.warning ? { warning: terminal.warning } : {})
  }
}

export function publishWorkerStartupBlocked(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  terminalHandle: string
  blockedReason: string
}): void {
  const message = args.db.insertMessage({
    runId: args.runId,
    from: `dispatch:${args.dispatchId}`,
    to: `run:${args.runId}`,
    subject: `Worker ${args.dispatchId} startup blocked: ${args.blockedReason}`,
    type: 'status',
    priority: 'high',
    payload: JSON.stringify({
      dispatchId: args.dispatchId,
      blockedReason: args.blockedReason,
      terminalHandle: args.terminalHandle
    })
  })
  args.runtime.notifyMessageArrived(message.to_handle, message.type)
}

// Why: createTerminal resolution is the identity barrier for a freshly
// spawned worker — handle registration, launch token and paneKey are stored
// before it resolves. The bounded retry covers only create variants whose
// registration timing differs; any other error is real and thrown as-is.
async function requireWorkerAuthorityAfterSpawn(
  runtime: OrcaRuntimeService,
  terminalHandle: string
) {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      return requireWorkerAuthority(runtime, terminalHandle)
    } catch (error) {
      const paneStillRegistering =
        error instanceof Error && error.message === 'stable_pane_required' && Date.now() < deadline
      if (!paneStillRegistering) {
        throw error
      }
      await delay(100)
    }
  }
}

function monitorArgvStartupBlocked(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  terminalHandle: string
  timeoutMs: number
}): void {
  void args.runtime
    .waitForTerminal(args.terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: args.timeoutMs
    })
    .then((wait) => {
      if (wait.satisfied) {
        return
      }
      if (!isReadyWorkerDispatch(args.db, args.dispatchId)) {
        return
      }
      publishWorkerStartupBlocked({
        runtime: args.runtime,
        db: args.db,
        runId: args.runId,
        dispatchId: args.dispatchId,
        terminalHandle: args.terminalHandle,
        blockedReason: readinessFailureReason(wait)
      })
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      if (reason === 'request_aborted' || reason === 'terminal_handle_stale') {
        return
      }
      if (!isReadyWorkerDispatch(args.db, args.dispatchId)) {
        return
      }
      publishWorkerStartupBlocked({
        runtime: args.runtime,
        db: args.db,
        runId: args.runId,
        dispatchId: args.dispatchId,
        terminalHandle: args.terminalHandle,
        blockedReason: `Terminal readiness wait failed: ${reason}`
      })
    })
}

function isReadyWorkerDispatch(db: OrchestrationDb, dispatchId: string): boolean {
  return (
    db.getDispatchContextById(dispatchId)?.status === 'dispatched' &&
    db.getWorkerDispatch(dispatchId)?.state === 'ready'
  )
}

function readinessFailureReason(
  wait: Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>
): string {
  if (wait.blockedReason) {
    return wait.blockedReason
  }
  return wait.status === 'exited'
    ? 'Terminal readiness wait failed: terminal_exited'
    : 'Terminal readiness wait was not satisfied.'
}
