import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { agentStartCeilingText } from './deliver-worker-dispatch-preamble'
import { readWorkerStartScreen } from '../../../../../../orchestration/workers/turn-stops/awaiting-worker-start-report'
import type { OrchestrationWorkerLaunchReceipt } from '../launch/worker-launch-preferences'
import type { WorkerEffect } from '../placement/worker-placement-topology'
import {
  awaitWorkerAgentInBackground,
  deadlineText,
  type AwaitingWorkerStart
} from './worker-start-background-readiness'
import { SETUP_WAIT_GATE_MAX_MS } from '../../../../../../../../shared/agent-launch/startup/setup-wait-output-gate'
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
    warning?: string
  }
): Promise<unknown> {
  const { dispatchId, terminalHandle, blockedReason } = args
  const awaited = awaitWorkerAgentInBackground(args)
  // A structured worker has no screen of its own; the Setup it waits on does.
  const setupTerminal = args.waitForStructuredSetup
    ? args.effects.find((effect) => effect.kind === 'setup')?.terminalId
    : undefined
  const screenHandle = setupTerminal ?? terminalHandle
  const screen = await readWorkerStartScreen(args.runtime, screenHandle)
  // Behind Setup, no time can be promised until Setup ends.
  const readyBy =
    awaited.readyBy === null || args.waitForStructuredSetup
      ? null
      : new Date(awaited.readyBy).toISOString()
  const by = readyBy ? `by ${readyBy}` : `within ${deadlineText()} of Setup ending`
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId,
    state: 'starting',
    stage: WORKER_AWAITING_AGENT_STAGE,
    ...(readyBy ? { readyBy } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    setup: args.setup,
    launch: args.launch,
    mode: args.mode,
    timeoutMs: args.timeoutMs,
    effects: args.effects,
    ...(screen ? { screen } : {}),
    ...(args.warning ? { warning: args.warning } : {}),
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${dispatchId} --json`,
      `orca terminal read --terminal ${screenHandle} --screen`,
      `orca orchestration worker-stop --dispatch ${dispatchId} --json`
    ],
    next: args.waitForStructuredSetup
      ? `Worker ${terminalHandle} (Dispatch ${dispatchId}) is live, but its Setup is still running. Orca sends the task once Setup finishes, waiting up to ${durationText(SETUP_WAIT_GATE_MAX_MS)} for Setup and then up to ${agentStartCeilingText()} for its agent to start, and you're told when it reports; if Setup fails or runs past that, the start fails and you're told then. Carry on with other work or end your turn; starting this task again would run it twice.`
      : blockedReason
        ? `Worker ${terminalHandle} (Dispatch ${dispatchId}) is live, but its agent is waiting on a screen only a person can answer (${blockedReason}); you'll get a separate message with that screen. Orca types the task in once the agent is ready, and fails the start if it isn't ready ${by}. Carry on with other work or end your turn; a new start would stop at the same screen.`
        : `Worker ${terminalHandle} (Dispatch ${dispatchId}) is live, but its agent isn't ready yet. Orca types the task in once it is, and you're told when it reports; if it isn't ready ${by}, the start fails and you're told then. Carry on with other work or end your turn; starting this task again would run it twice. If you think this launch has hung, because its screen (\`orca terminal read --terminal ${terminalHandle} --screen\`) shows something a fresh start would fix, stop it with \`orca orchestration worker-stop --dispatch ${dispatchId}\` and retry it with \`orca orchestration worker-start --task ${args.taskId} --retry-of ${dispatchId}\`.`
  }
}

function durationText(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`
}
