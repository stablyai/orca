import { normalizeConstruction } from './structured-agent-session-construction'
import {
  prepareNativeRecovery,
  recoveryConstructionIntent
} from './structured-agent-session-recovery'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  settleStructuredAgentSessionProviderStarted,
  type StructuredAgentSessionProviderStartedContext
} from './structured-agent-session-provider-started'

/** Await protocol construction outside conversation serialization. */
export async function openStructuredAgentSessionProviderChild(
  context: StructuredAgentSessionProviderStartedContext & {
    failStartingChild: (
      sessionId: string,
      child: StructuredAgentSessionProviderChildIdentity,
      error: unknown,
      openMs: number
    ) => Promise<void>
  },
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity
): Promise<void> {
  if (!context.runtimeState.startupAttempts.onClock(sessionId, child)) {
    return
  }
  const attempt = context.runtimeState.acquireAborts.begin(sessionId, false, false, () => {
    const current = context.sessions.get(sessionId)?.child
    return current !== undefined && current !== null && sameProviderChild(current, child)
  })
  const openedAt = context.now()
  try {
    attempt.signal.throwIfAborted()
    const acquisitionGeneration = child.generation
    if (acquisitionGeneration === null) {
      throw new Error('An unopened provider child has no acquisition generation')
    }
    const journal = context.sessions.get(sessionId)?.journal
    const record = context.deps.store.getRecord(sessionId)
    if (!journal || !record) {
      throw new Error('Recovery owner changed while opening')
    }
    const acquiredPermit = context.sessions.get(sessionId)?.child?.recoveryPermit
    const constructionIntent = acquiredPermit
      ? { kind: 'recovery' as const, permit: acquiredPermit }
      : await context.serialize(sessionId, async () =>
          recoveryConstructionIntent({
            store: context.deps.store,
            journal,
            record,
            now: context.now()
          })
        )
    const construction = normalizeConstruction(
      await waitForPromiseWithSignal(
        context.deps.adapter.open({
          sessionId,
          fence: child.fence,
          acquisitionGeneration,
          ...(constructionIntent ? { constructionIntent } : {}),
          signal: attempt.signal
        }),
        attempt.signal
      )
    )
    let recoveryPermit = acquiredPermit ?? constructionIntent?.permit
    const result =
      construction.kind === 'ready'
        ? construction.value
        : await construction.createFresh(
            (recoveryPermit = await context.serialize(sessionId, async () =>
              prepareNativeRecovery({
                store: context.deps.store,
                journal,
                record,
                source: construction.sourceLink,
                trigger: construction.trigger,
                now: context.now()
              })
            )),
            attempt.signal
          )
    if (attempt.signal.aborted) {
      return
    }
    await settleStructuredAgentSessionProviderStarted(
      context,
      {
        ...result,
        sessionId,
        fence: child.fence,
        acquisitionGeneration,
        ...(recoveryPermit ? { recoveryPermit } : {})
      },
      attempt.signal
    )
  } catch (error) {
    // Aborted startup already has a Stop/close/quit/expiry owner.
    if (!attempt.signal.aborted) {
      const openMs = Math.max(0, context.now() - openedAt)
      await context
        .failStartingChild(sessionId, child, error, openMs)
        .catch((closeError: unknown) =>
          context.deps.logger.warn('closing a failed provider open did not finish', {
            scope: 'provider-open-close',
            sessionId,
            error: closeError
          })
        )
    }
  } finally {
    attempt.end()
  }
}
