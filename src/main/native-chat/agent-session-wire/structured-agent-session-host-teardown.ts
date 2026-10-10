// Host teardown, made failure-complete.
//
// Every phase runs whatever an earlier one threw: `flushAllEventSinks` throws BY DESIGN when a
// sink barrier fails, and the attach drain can reject too. Each conversation is then retired — its
// admitted writes drained, what it still queues left for its next open to keep — before the
// runtime closes the one journal connection, last.

import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import { SUPERVISED_GRACEFUL_EXIT_MS } from '../../claude/claude-child-exit-proof-ladder'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import { SNAPSHOT_DRAIN_TIMEOUT_MS } from './structured-agent-session-eviction'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import {
  evictOwnedStructuredAgentSessions,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionTeardownPhase = {
  name: string
  run: () => Promise<void> | void
}

/** Advisory persistence must not hold shutdown open. */
export const RESUME_MARKER_RECORD_TIMEOUT_MS = 2_000

/** Covers a provider's stop observed late on a loaded host. */
export const EVICTION_MARGIN_MS = 1_000

/** A quit that dies mid-eviction leaves the lease unreleased — the exact state restart has to
 *  clean up — so this covers the sink drain plus the longest supervised provider close, well below
 *  the global quit deadline so later phases still run. A close's tree-kill fallback is outside it:
 *  once main exits the supervisor stops its group itself, and next launch's recovery settles the
 *  lease. Windows closes have no supervisor and wait less. */
export const CHILD_EVICTION_TIMEOUT_MS =
  SNAPSHOT_DRAIN_TIMEOUT_MS +
  Math.max(SUPERVISED_GRACEFUL_EXIT_MS, PROVIDER_SUPERVISOR_MAX_STOP_MS) +
  EVICTION_MARGIN_MS

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
    stopLeaseRenewal: () => Promise<void> | void
    flushAllEventSinks: () => Promise<void>
    acquireAborts: { abortAll: (reason: string) => void }
  }
  tasks: { drainAttaches: () => Promise<void> }
  evictOwnedSessions: () => Promise<void>
  /** Opens this teardown's witnesses; each session's own is taken as eviction stops its child. */
  beginResumeMarkers: () => void
  recordResumeMarkers: () => Promise<void>
  logger: StructuredAgentSessionLogger
}): StructuredAgentSessionTeardownPhase[] {
  return [
    {
      name: 'begin-resume-markers',
      run: () => {
        try {
          collaborators.beginResumeMarkers()
        } catch {
          collaborators.logger.warn('capturing recovery witnesses for teardown failed', {
            scope: 'teardown-recovery-witnesses'
          })
        }
      }
    },
    { name: 'dispose-idle-sweep', run: () => collaborators.idleSweep.dispose() },
    { name: 'stop-lease-renewal', run: () => collaborators.runtimeState.stopLeaseRenewal() },
    // Before the drain, which would otherwise wait out a start the provider never answers.
    {
      name: 'abort-acquires',
      run: () => collaborators.runtimeState.acquireAborts.abortAll('closed by quit')
    },
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
            collaborators.logger.warn('recording the recovery capsule at teardown failed', {
              scope: 'teardown-recovery-capsule'
            })
          }
        )
    },
    { name: 'flush-event-sinks', run: () => collaborators.runtimeState.flushAllEventSinks() }
  ]
}

async function tearDownStructuredAgentSessionHost(input: {
  phases: readonly StructuredAgentSessionTeardownPhase[]
  sessions: Map<string, StructuredAgentSessionHostSession>
  retainSessionIds?: ReadonlySet<string>
  acknowledgeSessionRelease?: (sessionId: string) => void
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
  // Quit settles nothing still queued: delivery and the queue's drain are already disposed, so
  // nothing hands it over now, and the next open settles it as it would after a crash. `allSettled`, so one failed close
  // cannot skip the others.
  const closed = await Promise.allSettled(
    entries.map(async ([, session]) => {
      await session.journal.close()
    })
  )
  closed.forEach((result, index) => {
    const sessionId = entries[index]?.[0]
    if (result.status === 'fulfilled') {
      // Only a closed conversation drops out; one whose close failed stays indexed for a retry.
      if (sessionId !== undefined) {
        input.sessions.delete(sessionId)
        input.acknowledgeSessionRelease?.(sessionId)
      }
      return
    }
    failures.push(result.reason)
  })

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
          retainSessionIds,
          context.trigger
        ),
      beginResumeMarkers: () => context.restartResume.beginTeardown(context.trigger),
      recordResumeMarkers: context.restartResume.recordMarkers,
      logger: context.deps.logger
    }),
    sessions: context.sessions,
    retainSessionIds,
    acknowledgeSessionRelease: (sessionId) =>
      context.deps.adapter.acknowledgeSessionRelease?.(sessionId)
  })
}
