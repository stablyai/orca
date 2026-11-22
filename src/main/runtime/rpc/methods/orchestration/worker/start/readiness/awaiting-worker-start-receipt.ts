import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { readWorkerStartScreen } from '../../../../../../orchestration/workers/turn-stops/awaiting-worker-start-report'
import type { OrchestrationWorkerLaunchReceipt } from '../launch/worker-launch-preferences'
import type { WorkerEffect } from '../placement/worker-placement-topology'
import {
  awaitWorkerAgentInBackground,
  type AwaitingWorkerStart
} from './worker-start-background-readiness'
import { WORKER_AWAITING_AGENT_STAGE } from '../../../../../../orchestration/db/worker-dispatch/worker-awaiting-agent-stage'

/** Leaves the start waiting on its agent in the background and returns the caller's receipt: the
 *  Dispatch is live, so a retry would duplicate it. */
export async function continueWorkerStartInBackground(
  args: AwaitingWorkerStart & {
    runId: string
    taskId: string
    launch: OrchestrationWorkerLaunchReceipt
    mode: WorkerStartModeReceipt
    timeoutMs: number
    effects: WorkerEffect[]
  }
): Promise<unknown> {
  const { dispatchId, terminalHandle, blockedReason } = args
  const awaited = awaitWorkerAgentInBackground(args)
  const screen = await readWorkerStartScreen(args.runtime, terminalHandle)
  const readyBy = new Date(awaited.readyBy).toISOString()
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId,
    state: 'starting',
    stage: WORKER_AWAITING_AGENT_STAGE,
    readyBy,
    ...(blockedReason ? { blockedReason } : {}),
    setup: args.setup,
    launch: args.launch,
    mode: args.mode,
    timeoutMs: args.timeoutMs,
    effects: args.effects,
    ...(screen ? { screen } : {}),
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${dispatchId} --json`,
      `orca terminal read --terminal ${terminalHandle} --screen`,
      `orca orchestration worker-stop --dispatch ${dispatchId} --json`
    ],
    next: blockedReason
      ? `Worker ${terminalHandle} (Dispatch ${dispatchId}) is live, but its agent is waiting on a screen only a person can answer (${blockedReason}); you'll get a separate message saying so. Orca types the task in once the agent is ready, and fails the start if it isn't by ${readyBy}. Don't start this task again; end your turn.`
      : `Worker ${terminalHandle} (Dispatch ${dispatchId}) is live, but its agent isn't ready yet. Orca types the task in once it is, and you're told when it reports; if it isn't ready by ${readyBy}, the start fails and you're told then. Don't start this task again; end your turn.`
  }
}
