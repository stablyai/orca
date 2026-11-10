import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionProviderChildIdentity } from '../host/structured-agent-session-host-types'
import {
  settleStructuredAgentSessionProviderStarted,
  type StructuredAgentSessionProviderStartedContext
} from './structured-agent-session-provider-started'
import {
  AgentSessionStartFailure,
  agentSessionStartFailure
} from './structured-agent-session-start-failure'
import {
  isStructuredAgentSessionStartupContractBreach,
  isStructuredAgentSessionStartupExpired
} from './structured-agent-session-startup-attempt-contract'

export type StructuredAgentSessionFailStartingChild = (
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity,
  failure: AgentSessionStartFailure,
  openMs: number
) => Promise<void>

/** The one owner of a starting child's outcome: it awaits the adapter's open and the start's
 *  required settlement outside serialization, then gives the start its verdict once. */
export async function openStructuredAgentSessionProviderChild(
  context: StructuredAgentSessionProviderStartedContext & {
    failStartingChild: StructuredAgentSessionFailStartingChild
  },
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity
): Promise<void> {
  const { startupAttempts, acquireAborts } = context.runtimeState
  // Once this owner is done, nothing reads how the acquisition ended before ready.
  const retire = (): void => {
    if (child.generation !== null) {
      context.deps.adapter.retireStartup?.(sessionId, child.generation)
    }
  }
  if (!startupAttempts.own(sessionId, child)) {
    retire()
    return
  }
  const attempt = acquireAborts.begin(sessionId)
  const openedAt = context.now()
  try {
    const outcome = await openAndSettle(context, sessionId, child, attempt.signal).catch(
      (error: unknown) =>
        attempt.signal.aborted
          ? stoppedStart(attempt.signal.reason)
          : error instanceof Error
            ? error
            : new Error(String(error))
    )
    if (outcome === 'ready') {
      return
    }
    if (!(outcome instanceof Error)) {
      startupAttempts.released(sessionId, child)
      return
    }
    const failure = agentSessionStartFailure(outcome)
    // Queued first so the start's row precedes any send that wakes on its verdict.
    const cleanup = context.failStartingChild(
      sessionId,
      child,
      failure,
      Math.max(0, context.now() - openedAt)
    )
    startupAttempts.failed(sessionId, child, failure)
    await cleanup.catch((error: unknown) =>
      context.deps.logger.warn('closing a failed provider open did not finish', {
        scope: 'provider-open-close',
        sessionId,
        error
      })
    )
  } finally {
    startupAttempts.disown(sessionId, child)
    context.publishStatus?.(sessionId)
    attempt.end()
    retire()
  }
}

async function openAndSettle(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity,
  signal: AbortSignal
): Promise<'ready' | 'stale' | Error> {
  signal.throwIfAborted()
  const acquisitionGeneration = child.generation
  if (acquisitionGeneration === null) {
    throw new Error('An unopened provider child has no acquisition generation')
  }
  const result = await waitForPromiseWithSignal(
    context.deps.adapter.open({ sessionId, fence: child.fence, acquisitionGeneration, signal }),
    signal
  )
  return waitForPromiseWithSignal(
    settleStructuredAgentSessionProviderStarted(
      context,
      { ...result, sessionId, fence: child.fence, acquisitionGeneration },
      signal
    ),
    signal
  )
}

/** Stop, close and quit settle through their own owner. The deadline and the contract guard
 *  already decided the start; the owner still records its row. */
function stoppedStart(reason: unknown): 'stale' | AgentSessionStartFailure {
  if (isStructuredAgentSessionStartupExpired(reason)) {
    return new AgentSessionStartFailure(reason, 'never', agentSessionFailureFact('hostStopped'))
  }
  if (isStructuredAgentSessionStartupContractBreach(reason)) {
    return new AgentSessionStartFailure(
      reason,
      'never',
      agentSessionFailureFact('providerStartFailed')
    )
  }
  return 'stale'
}
