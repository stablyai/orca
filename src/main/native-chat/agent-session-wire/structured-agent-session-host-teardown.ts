// Attempt every teardown phase despite earlier failures; drain conversation writes before closing
// the shared database last. Queued sends recover on next open.

import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import { SUPERVISED_GRACEFUL_EXIT_MS } from '../../claude/claude-child-exit-proof-ladder'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import { SNAPSHOT_DRAIN_TIMEOUT_MS } from './structured-agent-session-eviction'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-host'
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

export const RESUME_MARKER_RECORD_TIMEOUT_MS = 2_000

export const EVICTION_MARGIN_MS = 1_000

/** Cover drain and supervised graceful exit within quit’s deadline; supervisors own later tree cleanup. */
export const CHILD_EVICTION_TIMEOUT_MS =
  SNAPSHOT_DRAIN_TIMEOUT_MS +
  Math.max(SUPERVISED_GRACEFUL_EXIT_MS, PROVIDER_SUPERVISOR_MAX_STOP_MS) +
  EVICTION_MARGIN_MS

/** Bound duration while preserving rejection, unlike withTimeout alone. */
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

export function structuredAgentSessionHostTeardownPhases(collaborators: {
  idleSweep: { dispose: () => Promise<void> | void }
  runtimeState: {
    stopLeaseRenewal: () => Promise<void> | void
    flushAllEventSinks: () => Promise<void>
    acquireAborts: { abortAll: (reason: string) => void }
  }
  tasks: { drainAttaches: () => Promise<void> }
  evictOwnedSessions: () => Promise<void>
  /** Begin witnesses now; eviction captures each session immediately before child shutdown. */
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
    // Abort before drain so unanswered startup cannot block quit.
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
  // Delivery is disposed; next open recovers queued sends. allSettled ensures failed closes cannot skip others.
  const closed = await Promise.allSettled(
    entries.map(async ([, session]) => {
      await session.journal.close()
    })
  )
  closed.forEach((result, index) => {
    const sessionId = entries[index]?.[0]
    if (result.status === 'fulfilled') {
      // Retain failed closes for retry.
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
