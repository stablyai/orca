import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage
} from './orchestration-worker-setup-gate'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

// Why: agents whose promptInjectionMode is 'argv' start the first turn WITH
// the process — the dispatch preamble travels in the launch command, so
// there is no paste, no Enter, no submission verification window, and no
// agent_prompt_stalled revocation of a healthy worker. The capability and
// preamble exist before the terminal; the pane proves it is the exact
// spawned process by echoing the launch token it received in its
// environment. Nothing timing-based ever sits between spawn, bind and
// ready: a fast completion is settled, never refused.
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
  // Why: the caller's catch settles the dispatch with the stage that was
  // active when the failure happened; this callback keeps that ledger
  // accurate without threading a mutable variable through the module.
  onStage: (stage: string) => void
}): Promise<Record<string, unknown>> {
  const { runtime, db, effects } = args
  const preAllocatedHandle = runtime.createPreAllocatedTerminalHandle()
  const workerLaunchToken = randomUUID()
  db.commitDispatchLaunchTokenHash(
    args.dispatchId,
    createHash('sha256').update(workerLaunchToken).digest('hex')
  )
  const capability = db.mintStartingWorkerCapability({ dispatchId: args.dispatchId })
  const cliCommand = await runtime.getWorktreeOrchestrationCliCommand(args.worktreeId)
  const preamble = buildDispatchPreamble({
    taskId: args.task.id,
    dispatchId: args.dispatchId,
    taskSpec: args.task.spec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: preAllocatedHandle,
    dispatchCapability: capability,
    devMode: args.devMode,
    cliCommand
  })
  const terminal = await runtime.createTerminal(`id:${args.worktreeId}`, {
    startupAgent: args.agent,
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    preAllocatedHandle,
    launchToken: workerLaunchToken,
    agentPrompt: preamble,
    title: `worker-${args.task.id}`,
    // Why: dispatching a worker is background work; it must not pull the
    // sidebar to the worker's workspace while the user reads somewhere else.
    surfaceOwner: false
  })
  effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning
  })
  args.onStage('authority_bind')
  const setupStage = {
    db,
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    terminalHandle: terminal.handle,
    setup: args.setupReceipt,
    effects
  }
  // Why: createTerminal has already spawned the pane. failWorkerStartWithReceipt
  // rebuilds effects from DB, so the identity mismatch must persist the exact
  // terminal residual before it throws or the receipt loses the spawned handle.
  if (terminal.handle !== preAllocatedHandle) {
    persistWorkerReadinessStage(setupStage)
    throw new Error(
      `Worker terminal adopted handle ${terminal.handle} instead of the pre-allocated ${preAllocatedHandle}.`
    )
  }
  if (persistGatedSetupSpawnFailure(setupStage)) {
    args.onStage('setup_start')
    throw new Error('Setup terminal failed to start before the gated agent launch.')
  }
  persistWorkerReadinessStage(setupStage)
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
  // Why: nothing may sit between bind and ready — the dispatch context stays
  // 'pending' until markWorkerDispatchReady, and worker_done settlement
  // refuses a pending dispatch, so any gate here would reject a fast
  // completion. Blocked-screen detection is detached below.
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

// Why: an argv worker's brief is delivered at spawn, so a trust menu or
// update prompt that renders instead of the first turn must NOT fail the
// start — the dispatch identity is sound, and once the screen is cleared
// the agent runs the brief with a still-valid capability. Failing here
// would revoke that capability and orphan the recovered work; a timing
// gate before ready would refuse a fast completion. The scan is therefore
// detached evidence: ready returns immediately, and a detected blocked
// screen becomes a high-priority message to the Run.
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
      if (!wait.blockedReason) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Worker ${args.dispatchId} startup blocked: ${wait.blockedReason}`,
        type: 'status',
        priority: 'high',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          blockedReason: wait.blockedReason,
          terminalHandle: args.terminalHandle
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
}
