// Releasing one structured session's resources.
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
// the sink go.
//
// FAILURE. A step that fails ABORTS the rest. `closeSession` returning false means the child's
// exit was not proven and the adapter has deliberately kept the session indexed so a retry can
// reach it; forgetting it anyway stranded the process forever and reported success. Leaving the
// session in place is what makes the next close a real retry instead of a no-op.

import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

export type StructuredAgentSessionEvictionContext = {
  sessionId: string
  hasProviderChild?: boolean
  eventSink: DeferredStructuredAgentSessionEventSink
  adapter: StructuredAgentSessionAdapter
  forget: () => void
  /** Drops the cached sink so a later attach mints a fresh one. */
  discardSink: () => void
  /** Hands the lease back now that this host's child is proven gone. No-ops when the record is
   *  not this host's to release. */
  releaseLease: () => Promise<void>
}

export type StructuredAgentSessionEvictionStep = {
  name: string
  run: (context: StructuredAgentSessionEvictionContext) => Promise<void> | void
}

export const STRUCTURED_AGENT_SESSION_EVICTION_STEPS: readonly StructuredAgentSessionEvictionStep[] =
  [
    {
      name: 'stop-provider-child',
      run: async (context) => {
        if (context.hasProviderChild === false) {
          return
        }
        // An adapter with no close has nothing to stop; anything else must PROVE the exit.
        const stop = context.adapter.disposeSession ?? context.adapter.closeSession
        if (stop) {
          const stopped = await stop.call(context.adapter, context.sessionId)
          if (stopped !== true) {
            throw new Error('provider child exit was not proven')
          }
        }
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
    { name: 'stop-publishing', run: (context) => context.eventSink.unbind() },
    { name: 'close-sink', run: (context) => context.eventSink.close() },
    // Why: the runtime caches one sink per session id and hands the SAME instance to the next
    // attach. Closing without discarding leaves a reopened chat bound to a closed sink, which
    // accepts every provider event and publishes none. Attach's own failure path already pairs
    // these two; eviction has to as well.
    { name: 'discard-sink', run: (context) => context.discardSink() },
    // Why here and not last: the durable lease still names a process this host just stopped, and a
    // record left claiming a live owner is one nothing can resume — the next surface to open the
    // chat would find a session it may not acquire. Placed BEFORE forget so a release that cannot
    // be written aborts while the session is still indexed, which is what makes the retry real.
    { name: 'release-lease', run: (context) => context.releaseLease() },
    { name: 'forget-session', run: (context) => context.forget() }
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
