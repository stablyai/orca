import type { RuntimeTerminalWait } from '../../../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { agentStartupBlockedMessage } from '../../../../../../terminal/wait/agent-startup-blocked-message'
import { waitForWorkerAgentReady } from '../../../../../../terminal/wait/launched-agent-composer-readiness'
import { watchSetupEnd, type SetupEndWatch } from './worker-setup-end-watch'
import type { createStructuredWorkerSessionForWorktree } from '../placement/worker-placement-topology'
import { persistWorkerSetupWaitOutcome, type WorkerSetupStageArgs } from './worker-setup-gate'
import { continueWorkerStartInBackground } from './awaiting-worker-start-receipt'
import {
  readinessStillPending,
  workerPanePtyId,
  type WorkerReadinessWaitArgs
} from './worker-start-background-readiness'
import {
  awaitStructuredWorkerSetupGate,
  type StructuredWorkerSetupGate
} from './worker-start-structured-setup-gate'

type PlacedWorkerReadiness = {
  runtime: OrcaRuntimeService
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  workerChat: boolean
  setupStage: WorkerSetupStageArgs
  readiness: WorkerReadinessWaitArgs
  timeoutMs: number
  readinessDeadline: number
  onSetupFailed: () => void
}

/** Hands the brief over once the placed worker can take it: now when ready within the caller's
 *  budget, else from the background wait, returning the receipt that says so. */
export async function handOverWhenReady(
  args: PlacedWorkerReadiness & {
    launchedAt: number
    receipt: Pick<
      Parameters<typeof continueWorkerStartInBackground>[0],
      'runId' | 'taskId' | 'launch' | 'mode'
    >
    handOver: (deliveryDeadline?: number) => Promise<unknown>
    onHandedOver: (outcome: unknown) => void
    fail: (error: unknown, failedStage?: string) => Promise<unknown>
  }
): Promise<unknown> {
  const { setupStage } = args
  const setupEnd = watchLaunchSetupEnd(args)
  let pending: Awaited<ReturnType<typeof awaitPlacedWorkerReadiness>>
  try {
    pending = await awaitPlacedWorkerReadiness(args)
  } catch (error) {
    setupEnd?.dispose()
    throw error
  }
  if (!pending) {
    setupEnd?.dispose()
    return args.handOver()
  }
  return continueWorkerStartInBackground({
    ...args.receipt,
    runtime: args.runtime,
    db: setupStage.db,
    dispatchId: setupStage.dispatchId,
    terminalHandle: setupStage.terminalHandle,
    readiness: args.readiness,
    setup: setupStage.setup,
    effects: setupStage.effects,
    timeoutMs: args.timeoutMs,
    launchedAt: args.launchedAt,
    setupEnd,
    blockedReason: pending.blockedReason,
    handOver: async (ready) => {
      persistWorkerSetupWaitOutcome({ ...setupStage, wait: ready })
      const handedOver = args.handOver(Date.now() + args.timeoutMs)
      args.onHandedOver(await handedOver.catch((error: unknown) => args.fail(error)))
    },
    fail: async (error, failedStage) => {
      await args.fail(error, failedStage)
    }
  })
}

/** A launch held behind a wait-for-setup Setup, watched from now so the line its wrapper prints when
 *  Setup ends is seen however much the agent prints after it. */
function watchLaunchSetupEnd(args: PlacedWorkerReadiness): SetupEndWatch | null {
  const { setup, terminalHandle } = args.setupStage
  if (
    args.structuredSession ||
    args.workerChat ||
    setup.startupPolicy !== 'wait-for-setup' ||
    setup.state !== 'running'
  ) {
    return null
  }
  const ptyId = workerPanePtyId(args.runtime, terminalHandle, args.readiness)
  return ptyId ? watchSetupEnd(args.runtime, ptyId) : null
}

/** Waits, within the caller's budget, for the placed worker to take its brief. Null: it can now. Else
 *  its agent is not ready in a way waiting on can fix; a real failure throws. */
async function awaitPlacedWorkerReadiness(
  args: PlacedWorkerReadiness
): Promise<ReturnType<typeof readinessStillPending>> {
  const { runtime, structuredSession, setupStage } = args
  const terminalHandle = setupStage.terminalHandle
  let wait: StructuredWorkerSetupGate | RuntimeTerminalWait | null = null
  // Structured readiness comes from preamble delivery, not TUI idle; only repo wait-for-setup policy gates here.
  if (structuredSession) {
    wait = await awaitStructuredWorkerSetupGate({
      runtime,
      setup: setupStage.setup,
      effects: setupStage.effects,
      timeoutMs: Math.max(0, args.readinessDeadline - Date.now())
    })
  } else if (!args.workerChat) {
    // A chat takes its task as a queued send whatever it is doing, so nothing is waited on.
    try {
      const agentWait = await waitForWorkerAgentReady(runtime, terminalHandle, {
        ...args.readiness,
        timeoutMs: args.timeoutMs
      })
      const pending = readinessStillPending({ wait: agentWait })
      if (pending) {
        return pending
      }
      wait = agentWait
    } catch (error) {
      const pending = readinessStillPending({ error })
      if (!pending) {
        throw error
      }
      return pending
    }
  }
  if (!wait) {
    return null
  }
  persistWorkerSetupWaitOutcome({ ...setupStage, wait })
  if (!wait.satisfied) {
    if (setupStage.setup.state === 'failed') {
      args.onSetupFailed()
    }
    throw new Error(
      wait.blockedReason
        ? await agentStartupBlockedMessage(runtime, terminalHandle, wait.blockedReason)
        : structuredSession
          ? `Setup did not finish before the structured worker started (${wait.status}).`
          : `Agent did not become ready (${wait.status}).`
    )
  }
  return null
}
