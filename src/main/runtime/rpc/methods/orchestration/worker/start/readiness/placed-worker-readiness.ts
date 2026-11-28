import type { RuntimeTerminalWait } from '../../../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { agentStartupBlockedMessage } from '../../../../../../terminal/wait/agent-startup-blocked-message'
import { waitForWorkerAgentReady } from '../../../../../../terminal/wait/launched-agent-composer-readiness'
import { watchSetupEnd, type SetupEndWatch } from './worker-setup-end-watch'
import type { createStructuredWorkerSessionForWorktree } from '../placement/worker-placement-topology'
import { persistWorkerSetupWaitOutcome, type WorkerSetupStageArgs } from './worker-setup-gate'
import { continueWorkerStartInBackground } from './awaiting-worker-start-receipt'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import {
  readinessStillPending,
  workerPanePtyId,
  type WorkerReadinessWaitArgs
} from './worker-start-background-readiness'
import {
  watchStructuredWorkerSetup,
  type StructuredWorkerSetupGate,
  type StructuredWorkerSetupWatch
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
      'runId' | 'taskId' | 'launch' | 'mode' | 'warning'
    >
    handOver: (deliveryDeadline?: number) => Promise<unknown>
    bindTerminal: () => void
    onHandedOver: (outcome: unknown) => void
    fail: (error: unknown, failedStage?: string) => Promise<unknown>
  }
): Promise<unknown> {
  const { setupStage } = args
  const setupEnd = watchLaunchSetupEnd(args)
  // A structured worker's one Setup wait: the background wait takes it over if the budget ends first.
  const setupWatch = args.structuredSession
    ? watchStructuredWorkerSetup({
        runtime: args.runtime,
        setup: setupStage.setup,
        effects: setupStage.effects
      })
    : null
  let pending: Awaited<ReturnType<typeof awaitPlacedWorkerReadiness>>
  try {
    pending = await awaitPlacedWorkerReadiness(args, setupWatch)
  } catch (error) {
    setupEnd?.dispose()
    setupWatch?.dispose()
    throw error
  }
  if (!pending) {
    setupEnd?.dispose()
    setupWatch?.dispose()
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
    ...(setupWatch ? { waitForStructuredSetup: waitInBackground(args, setupWatch) } : {}),
    handOver: async (ready) => {
      const handedOver = (async () => {
        if (ready) {
          await settleReadinessWait(args, ready)
        }
        // A fresh budget; a structured agent only starts now, under its host's own startup ceiling.
        return args.handOver(Date.now() + args.timeoutMs)
      })()
      args.onHandedOver(await handedOver.catch((error: unknown) => args.fail(error)))
    },
    bindTerminal: args.bindTerminal,
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
  args: PlacedWorkerReadiness,
  setupWatch: StructuredWorkerSetupWatch | null
): Promise<ReturnType<typeof readinessStillPending>> {
  const { runtime, structuredSession, setupStage } = args
  const terminalHandle = setupStage.terminalHandle
  let wait: StructuredWorkerSetupGate | RuntimeTerminalWait | null = null
  // Structured readiness comes from preamble delivery, not TUI idle; only repo wait-for-setup policy gates here.
  if (structuredSession) {
    wait = setupWatch
      ? await setupWatch.within(Math.max(0, args.readinessDeadline - Date.now()))
      : null
    // Setup still running at the budget: wait on in the background, as an agent not yet ready does.
    if (wait && !wait.satisfied && wait.status === 'timeout') {
      return {}
    }
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
  if (wait) {
    await settleReadinessWait(args, wait)
  }
  return null
}

/** A reused slept agent resumes in place first, so readiness, authority and custody are its woken
 *  process's; returns the stopped process whose custody passes to the resume. */
export async function wakeReusedSleptAgent(
  runtime: OrcaRuntimeService,
  placed: Pick<PlacedWorkerReadiness, 'structuredSession'> & { terminalHandle: string },
  workerChat: unknown,
  timeoutMs: number
): Promise<string | null> {
  if (placed.structuredSession || workerChat) {
    return null
  }
  const incarnation = runtime.sleptAgentProcessIncarnation(placed.terminalHandle)
  await runtime.wakeSleptAgentHandle(placed.terminalHandle, { timeoutMs })
  return incarnation
}

/** Records the wait's Setup outcome; one that left the worker unready fails the start. */
async function settleReadinessWait(
  args: PlacedWorkerReadiness,
  wait: StructuredWorkerSetupGate | RuntimeTerminalWait
): Promise<void> {
  const { runtime, structuredSession, setupStage } = args
  persistWorkerSetupWaitOutcome({ ...setupStage, wait })
  if (wait.satisfied) {
    return
  }
  const unobserved = 'reason' in wait && wait.status === 'unobserved'
  if (setupStage.setup.state === 'failed' || unobserved) {
    args.onSetupFailed()
  }
  throw new Error(
    wait.blockedReason
      ? await agentStartupBlockedMessage(runtime, setupStage.terminalHandle, wait.blockedReason)
      : unobserved
        ? `Orca lost sight of Setup (${wait.reason}), so it never sent the brief; Setup may still be running.`
        : structuredSession
          ? `Setup did not finish before the structured worker started (${wait.status}).`
          : `Agent did not become ready (${wait.status}).`
  )
}

/** The background wait on a structured worker's Setup; a stop during it releases the session. */
function waitInBackground(args: PlacedWorkerReadiness, setupWatch: StructuredWorkerSetupWatch) {
  const { runtime, structuredSession, setupStage } = args
  return async (signal: AbortSignal, timeoutMs: number) => {
    try {
      return await setupWatch.within(timeoutMs, signal)
    } catch (error) {
      if (signal.aborted) {
        await tearDownFailedWorkerStart({
          runtime,
          structuredSession,
          dispatchId: setupStage.dispatchId,
          error
        })
      }
      throw error
    } finally {
      setupWatch.dispose()
    }
  }
}
