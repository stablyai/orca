// Host teardown, made failure-complete.
//
// A trailing "close every journal" statement is skipped on exactly the path
// that leaks: `flushAllEventSinks` throws BY DESIGN when a sink barrier fails,
// and the attach drain can reject too. Every connection would then be left open
// with the global runtime reference already cleared — the one state from which
// nothing can ever close them.

import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-host'
import {
  abandonQueuedStructuredAgentSessionMessages,
  evictOwnedStructuredAgentSessions,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type StructuredAgentSessionTeardownPhase = {
  name: string
  run: () => Promise<void> | void
}

/** Advisory persistence must not hold shutdown open. */
const RESUME_MARKER_RECORD_TIMEOUT_MS = 2_000

/** Eight steps at ten seconds each would outlast the global quit deadline, and a quit that dies
 *  mid-eviction leaves the lease unreleased — the exact state restart has to clean up. Bounded
 *  well below that deadline so the phases after this one still get to run. */
const CHILD_EVICTION_TIMEOUT_MS = 8_000

/** Bounds a phase without swallowing its failure, which `withTimeout` alone would. */
async function withPhaseTimeout(run: () => Promise<void>, timeoutMs: number): Promise<void> {
  const settled = run().then(
    () => ({ failed: false }) as const,
    (error: unknown) => ({ failed: true, error }) as const
  )
  const outcome = await withTimeout<Awaited<typeof settled> | null>(settled, timeoutMs, null)
  if (outcome === null) {
    throw new Error(`agent session host teardown phase did not finish within ${timeoutMs}ms`)
  }
  if (outcome.failed) {
    throw outcome.error
  }
}

/** The quit-path phase order, which is load-bearing rather than incidental. */
export function structuredAgentSessionHostTeardownPhases(collaborators: {
  idleSweep: { dispose: () => Promise<void> | void }
  runtimeState: {
    stopLeaseRenewal: () => void
    flushAllEventSinks: () => Promise<void>
  }
  tasks: { drainAttaches: () => Promise<void> }
  evictOwnedSessions: () => Promise<void>
  /** Opens this teardown's witnesses; each session's own is taken as eviction stops its child. */
  beginResumeMarkers: () => void
  recordResumeMarkers: () => Promise<void>
}): StructuredAgentSessionTeardownPhase[] {
  return [
    // First: once quit begins, a start that lands must not withdraw an offer teardown captures.
    { name: 'dispose-idle-sweep', run: () => collaborators.idleSweep.dispose() },
    {
      name: 'begin-resume-markers',
      run: () => {
        try {
          collaborators.beginResumeMarkers()
        } catch {
          console.warn('[structured-agent-session] capturing recovery witnesses failed')
        }
      }
    },
    { name: 'stop-lease-renewal', run: () => collaborators.runtimeState.stopLeaseRenewal() },
    { name: 'drain-attaches', run: () => collaborators.tasks.drainAttaches() },
    {
      name: 'evict-owned-sessions',
      run: () => withPhaseTimeout(collaborators.evictOwnedSessions, CHILD_EVICTION_TIMEOUT_MS)
    },
    {
      name: 'record-resume-markers',
      run: () =>
        withPhaseTimeout(collaborators.recordResumeMarkers, RESUME_MARKER_RECORD_TIMEOUT_MS).catch(
          () => {
            console.warn('[structured-agent-session] recording recovery capsule failed')
          }
        )
    },
    { name: 'flush-event-sinks', run: () => collaborators.runtimeState.flushAllEventSinks() }
  ]
}

export async function tearDownStructuredAgentSessionHost(input: {
  phases: readonly StructuredAgentSessionTeardownPhase[]
  sessions: Map<string, StructuredAgentSessionHostSession>
  retainSessionIds?: ReadonlySet<string>
  acknowledgeSessionRelease?: (sessionId: string) => void
  /** Quit closes every conversation, so it settles what they still queue as a close does. */
  abandonQueued?: (sessionId: string, session: StructuredAgentSessionHostSession) => Promise<void>
}): Promise<void> {
  const failures: unknown[] = []
  for (const phase of input.phases) {
    try {
      await phase.run()
    } catch (error) {
      failures.push(error)
    }
  }

  const entries = [...input.sessions.entries()].filter(
    ([sessionId]) => !input.retainSessionIds?.has(sessionId)
  )
  // `allSettled`, so one rejected close cannot skip the others.
  const closed = await Promise.allSettled(
    entries.map(async ([sessionId, session]) => {
      await input.abandonQueued?.(sessionId, session)
      await session.journal.close()
    })
  )
  closed.forEach((result, index) => {
    const sessionId = entries[index]?.[0]
    if (result.status === 'fulfilled') {
      // Only a FULFILLED close drops the entry. One that rejected stays indexed,
      // which is what makes a later close a real retry rather than a no-op.
      if (sessionId !== undefined) {
        input.sessions.delete(sessionId)
        input.acknowledgeSessionRelease?.(sessionId)
      }
      return
    }
    failures.push(result.reason)
  })

  // Journals an earlier failure path could not close are retried HERE, which is
  // the only place that owns them once their caller has unwound.
  failures.push(...(await agentSessionJournalCloseRetries.retryAll()))

  if (failures.length > 0) {
    throw new AggregateError(failures, 'agent session host teardown failed')
  }
}

export async function flushStructuredAgentSessionHost(
  context: StructuredAgentSessionLifetimeContext &
    Pick<Parameters<typeof structuredAgentSessionHostTeardownPhases>[0], 'idleSweep' | 'tasks'> & {
      restartResume: StructuredAgentSessionRestartResume
      serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
      trigger: AgentSessionResumeTrigger
    }
): Promise<void> {
  const retainSessionIds = new Set<string>()
  await tearDownStructuredAgentSessionHost({
    phases: structuredAgentSessionHostTeardownPhases({
      ...context,
      evictOwnedSessions: () =>
        evictOwnedStructuredAgentSessions(
          {
            ...context,
            restartWitness: {
              beforeStop: context.restartResume.captureBeforeStop,
              stopped: context.restartResume.confirmStopped
            }
          },
          retainSessionIds
        ),
      beginResumeMarkers: () => context.restartResume.beginTeardown(context.trigger),
      recordResumeMarkers: context.restartResume.recordMarkers
    }),
    sessions: context.sessions,
    retainSessionIds,
    acknowledgeSessionRelease: (sessionId) =>
      context.deps.adapter.acknowledgeSessionRelease?.(sessionId),
    abandonQueued: (sessionId, session) =>
      abandonQueuedStructuredAgentSessionMessages(context.deps, sessionId, session.journal)
  })
}
