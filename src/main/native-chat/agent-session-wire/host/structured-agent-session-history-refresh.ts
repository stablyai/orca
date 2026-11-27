import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { createDeferredStructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import { recordHistoryRefreshSkipped } from './structured-agent-session-history-refresh-status'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

/** External I/O owns an abortable wait, never the conversation lane. */
export async function refreshStructuredAgentSessionHistory(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession | undefined,
  available: () => boolean,
  signal: AbortSignal,
  publish: () => void
): Promise<void> {
  const refresh = deps.adapter.refreshHistory
  const record = deps.store.getRecord(sessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (
    !refresh ||
    !record ||
    !head ||
    !session ||
    session.child ||
    !available() ||
    record.lease.claimStatus !== 'released' ||
    record.lease.unreconciled
  ) {
    return
  }
  const { journal } = session
  const cursor = journal.physicalCursor()
  const admittedSends = deps.store.admittedSendCount(sessionId)
  const assertCurrent = () => {
    const current = deps.store.getRecord(sessionId)
    if (
      signal.aborted ||
      journal.isClosed ||
      !available() ||
      session.child ||
      !current ||
      deps.store.admittedSendCount(sessionId) !== admittedSends ||
      current.lease.claimStatus !== 'released' ||
      current.lease.unreconciled ||
      current.lease.runtimeFence !== record.lease.runtimeFence ||
      agentSessionProviderHandleChainHead(current.providerHandleChain)?.linkId !== head.linkId ||
      JSON.stringify(current.accountHome) !== JSON.stringify(record.accountHome)
    ) {
      throw new Error('history-refresh-superseded')
    }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('history-refresh-timeout')), 15_000)
  const reading = AbortSignal.any([signal, controller.signal])
  const stopOnSend = deps.store.onAcceptedSend((id) => {
    if (id === sessionId) {
      controller.abort(new Error('history-refresh-superseded'))
    }
  })
  const deferred = createDeferredStructuredAgentSessionEventSink({ sessionId, logger: deps.logger })
  let skipped: string | undefined
  try {
    const pending = await waitForPromiseWithSignal(
      journal.reads.input({ kind: 'unsettled-submissions' }),
      reading
    )
    if (pending.submissions.length) {
      return
    }
    assertCurrent()
    deferred.bind({ journal, fence: record.lease.runtimeFence, publish })
    try {
      await waitForPromiseWithSignal(
        refresh.call(deps.adapter, {
          record,
          providerSessionId: head.handle.nativeId,
          sink: {
            ...deferred.sink,
            tryAppendTransition: (transition) =>
              deferred.sink.tryAppendTransition!({
                ...transition,
                beforeRun: () =>
                  sameJournalCursor(cursor, journal.physicalCursor()) &&
                  (transition.beforeRun?.() ?? true)
              })
          },
          signal: reading,
          assertCurrent: () => {
            reading.throwIfAborted()
            assertCurrent()
          },
          onSkipped: (reason) => {
            skipped = reason
          }
        }),
        reading
      )
    } catch (error) {
      skipped = controller.signal.aborted ? 'timeout' : 'failed'
      deps.logger.warn('reading external history while opening the chat failed', {
        scope: 'history-refresh',
        sessionId,
        error
      })
    }
    if (skipped) {
      assertCurrent()
      await recordHistoryRefreshSkipped({
        sessionId,
        sink: deferred.sink,
        signal,
        assertCurrent,
        cursor,
        head: head.linkId,
        reason: skipped
      })
    }
    await waitForPromiseWithSignal(deferred.drained(), signal)
  } catch (error) {
    if (!signal.aborted) {
      deps.logger.warn('external history refresh ended without updating the chat', {
        scope: 'history-refresh',
        sessionId,
        error
      })
    }
  } finally {
    stopOnSend()
    clearTimeout(timeout)
    controller.abort()
    deferred.close()
  }
}
