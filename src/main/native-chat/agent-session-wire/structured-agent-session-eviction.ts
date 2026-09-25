// Stopping one structured session's provider child and handing its lease back.
//
// Teardown is a DATA list, not a method body, for the reason this file exists at all: the host
// tracked which sessions were live in a map, and tore them down at three unrelated call sites
// (app quit, handoff to a TUI, and error cleanup). Closing a chat was never wired to any of them,
// so a provider child outlived the chat that owned it for the whole app session.
//
// ORDER. The provider child stops FIRST. Closing it is not silent: the codex adapter emits its
// `ended` event and flushes coalesced text as part of shutting down, and those are the rows that
// clear the running-turn marker. Draining or closing the sink ahead of that drops them, which
// leaves the durable journal claiming the agent is still working — a worse outcome than the leak
// this teardown exists to fix. So: stop the child, drain what it emitted on its way out, then let
// the sink go. The one step ahead of the stop only reads, for quit's resume offer.
//
// FAILURE. A step that fails ABORTS the rest. `closeSession` returning false means the child's
// exit was not proven and the adapter has deliberately kept the session indexed so a retry can
// reach it; forgetting it anyway stranded the process forever and reported success. Leaving the
// session in place is what makes the next close a real retry instead of a no-op.

import {
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

export type StructuredAgentSessionEvictionContext = {
  sessionId: string
  hasProviderChild?: boolean
  eventSink: DeferredStructuredAgentSessionEventSink
  adapter: StructuredAgentSessionAdapter
  /** Tells the adapter the released lease is done with, so it drops this child's route and index.
   *  The conversation stays: stopping the agent never closes its journal. */
  acknowledgeRelease: () => Promise<void> | void
  /** Drops the cached sink so a later attach mints a fresh one. */
  discardSink: () => void
  /** Fires right before the stop, while the child's turn and background roster are still live. A
   *  throw is logged, never allowed to abort the stop. */
  beforeProviderChildStop?: () => void
  /** Fires once the adapter has PROVEN the child gone, so host bookkeeping stops claiming one. */
  onProviderChildStopped?: () => void
  /** Whether this host still owes the child's wind-down. Distinct from `hasProviderChild`, which a
   *  proven exit retires mid-run: the two disagree for exactly the steps a retry has to repeat. */
  owesProviderChildWindDown?: boolean
  /** Settles work owned by the child after its final callbacks have drained. */
  settleWork?: () => Promise<void>
  /** Hands the lease back now that this host's child is proven gone. No-ops when the record is
   *  not this host's to release. */
  releaseLease: () => Promise<void>
}

/** The resume offer is advisory; a stalled sink must not hold the child's stop behind it. */
const SNAPSHOT_DRAIN_TIMEOUT_MS = 1_000

export type StructuredAgentSessionEvictionStep = {
  name: string
  run: (context: StructuredAgentSessionEvictionContext) => Promise<void> | void
}

export const STRUCTURED_AGENT_SESSION_EVICTION_STEPS: readonly StructuredAgentSessionEvictionStep[] =
  [
    {
      // Quit's resume offer: what the sidebar shows, read while the child is still running.
      name: 'snapshot-before-stop',
      run: async (context) => {
        if (context.hasProviderChild === false || !context.beforeProviderChildStop) {
          return
        }
        // Events the provider already delivered are part of what the sidebar showed at the stop.
        await withTimeout<unknown>(context.eventSink.drained(), SNAPSHOT_DRAIN_TIMEOUT_MS, null)
        try {
          context.beforeProviderChildStop()
        } catch {
          console.warn('[structured-agent-session] capturing recovery witness failed')
        }
      }
    },
    {
      name: 'stop-provider-child',
      run: async (context) => {
        if (context.hasProviderChild === false) {
          return
        }
        // An adapter with no close has nothing to stop; anything else must PROVE the exit.
        const stop = context.adapter.disposeSession ?? context.adapter.closeSession
        if (stop) {
          try {
            const stopped = await stop.call(context.adapter, context.sessionId)
            if (stopped !== true) {
              throw new Error('provider child exit was not proven')
            }
          } catch (error) {
            // Why: lease ownership follows the provider root; known-live descendants still throw unproven.
            if (
              !(error instanceof AgentSessionAcquisitionRootExitObservedError) &&
              !(error instanceof AgentSessionPreSpawnError)
            ) {
              throw error
            }
          }
        }
        context.onProviderChildStopped?.()
      }
    },
    {
      name: 'drain-published',
      run: async (context) => {
        const barrier = await context.eventSink.drained()
        if (!barrier.ok) {
          throw barrier.error
        }
      }
    },
    {
      name: 'settle-dead-generation',
      run: (context) =>
        context.owesProviderChildWindDown === false ? undefined : context.settleWork?.()
    },
    { name: 'stop-publishing', run: (context) => context.eventSink.unbind() },
    { name: 'close-sink', run: (context) => context.eventSink.close() },
    // Why: the runtime caches one sink per session id and hands the SAME instance to the next
    // attach. Closing without discarding leaves a reopened chat bound to a closed sink, which
    // accepts every provider event and publishes none. Attach's own failure path already pairs
    // these two; eviction has to as well.
    { name: 'discard-sink', run: (context) => context.discardSink() },
    // Why here and not last: the durable lease still names a process this host just stopped, and a
    // record left claiming a live owner is one nothing can resume — the next send would find a
    // session it may not acquire. Placed BEFORE the acknowledgement so a release that cannot be
    // written aborts while the adapter still routes the session, which is what makes the retry real.
    { name: 'release-lease', run: (context) => context.releaseLease() },
    { name: 'acknowledge-release', run: (context) => context.acknowledgeRelease() }
  ]

export class StructuredAgentSessionEvictionError extends Error {
  constructor(
    readonly step: string,
    readonly sessionId: string,
    override readonly cause: unknown
  ) {
    super(`agent session eviction failed at step "${step}" for ${sessionId}`)
    this.name = 'StructuredAgentSessionEvictionError'
  }
}

/**
 * Runs the eviction steps in order, stopping at the first failure. The step name travels with the
 * error because the caller's only useful response is to retry, and a retry is only safe when the
 * session is still indexed — which is exactly what aborting preserves.
 */
export async function evictStructuredAgentSession(
  context: StructuredAgentSessionEvictionContext,
  steps: readonly StructuredAgentSessionEvictionStep[] = STRUCTURED_AGENT_SESSION_EVICTION_STEPS
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run(context)
    } catch (error) {
      throw new StructuredAgentSessionEvictionError(step.name, context.sessionId, error)
    }
  }
}
