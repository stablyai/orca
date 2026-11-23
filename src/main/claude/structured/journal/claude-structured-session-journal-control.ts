import {
  bindClaudeContextUsageCapture,
  type ClaudeContextUsageCaptureOptions
} from '../../context-usage/claude-context-usage'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeStreamJsonConnection } from '../../claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeInitProof } from '../startup/claude-structured-init-proof'
import type { ClaudeJournalBoundDelivery } from './claude-journal-bound-delivery'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSession,
  ClaudeAcquireCallbacks
} from '../claude-structured-session-state'

export function createClaudeSessionJournalTranslator(
  sink: StructuredAgentSessionEventSink | undefined,
  fallbackIdPrefix: string,
  failure: Parameters<typeof createClaudeJournalFailureHandler>[0],
  currentSession: () => ClaudeSession | null,
  acceptStartupFailure: (message: Record<string, unknown>) => boolean
): { translator: ClaudeJournalTranslator | null; recheckPermissionNotice: () => void } {
  const { attempt, callbacks, sessionId } = failure
  attempt.delivery.onFailure = createClaudeJournalFailureHandler(failure)
  attempt.delivery.bind(sink)
  const translator = sink
    ? createClaudeJournalTranslator({
        sink,
        delivery: attempt.delivery,
        account: () => attempt.launch?.account,
        model: () => {
          const session = currentSession()
          return (
            session?.appliedInputOptions.get('model') ??
            session?.options.get('model') ??
            session?.launchIntent?.model ??
            session?.reportedOptions.model
          )
        },
        fallbackIdPrefix,
        goalBackgroundWork: () =>
          currentSession()?.backgroundTasks.goalBackgroundWork ?? 'unverifiable',
        onBackgroundTaskJournalFailure: createClaudeJournalFailureHandler(failure),
        bindPromptItemId: (itemId, promptKey) =>
          attempt.prompts.bindJournalItemId(itemId, promptKey),
        acceptStartupFailure,
        permissionNoticeSession: currentSession,
        steerAwaitingEcho: () =>
          currentSession()?.dispatchWaiters.some((waiter) => waiter.steers) ?? false
      })
    : null
  return {
    translator,
    recheckPermissionNotice: createClaudePermissionNoticeRecheck(
      translator,
      (run) => callbacks.deliver(attempt, sessionId, run),
      attempt.delivery.onFailure
    )
  }
}

export function createClaudeJournalFailureHandler(input: {
  attempt: ClaudeAcquisitionAttempt
  initProof: ClaudeInitProof
  callbacks: ClaudeAcquireCallbacks
  sessionId: string
}): (error: Error) => void {
  return (error) => {
    if (!input.attempt.published) {
      input.initProof.reject(error)
      return
    }
    const connection = input.attempt.connection
    if (connection) {
      void connection
        .close()
        .catch(() => false)
        .finally(() => input.callbacks.handleExit(input.sessionId, input.attempt, error))
    }
  }
}

export function createClaudePermissionNoticeRecheck(
  translator: ClaudeJournalTranslator | null,
  deliver: (run: () => void) => void,
  onFailure: (error: Error) => void
): () => void {
  let queued = false
  return () => {
    if (!translator || queued) {
      return
    }
    queued = true
    queueMicrotask(() => {
      try {
        deliver(() => {
          queued = false
          translator.recheckPermissionNotice?.()
        })
      } catch (error) {
        onFailure(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

// Retry on drain because the provider may send no further events.
function retryOwedWritesOnDrain(
  translator: ClaudeJournalTranslator | null
): StructuredAgentSessionSinkAdmission {
  const tasks = translator?.retryPendingTaskRows?.() ?? { accepted: true }
  if (!tasks.accepted && tasks.reason === 'backpressure') {
    return tasks
  }
  const cancellations = translator?.retryPendingCancellations?.()
  if (cancellations && !cancellations.accepted && cancellations.reason === 'backpressure') {
    return cancellations
  }
  return translator?.retryPermissionNotice?.() ?? cancellations ?? { accepted: true }
}

export function bindClaudeJournalReadingControl(
  sink: StructuredAgentSessionEventSink | undefined,
  connection: Pick<ClaudeStreamJsonConnection, 'pauseReading' | 'resumeReading'>,
  translator: ClaudeJournalTranslator | null,
  delivery?: ClaudeJournalBoundDelivery
): (() => void) | undefined {
  if (!connection.pauseReading || !connection.resumeReading) {
    return undefined
  }
  let sinkPaused = false
  let journalPaused = false
  const resume = () => {
    if (!sinkPaused && !journalPaused) {
      connection.resumeReading?.()
    }
  }
  const unbindDelivery = delivery?.bindReadingControl({
    pauseReading: () => {
      journalPaused = true
      connection.pauseReading?.()
    },
    resumeReading: () => {
      journalPaused = false
      resume()
    }
  })
  const unbindSink = sink?.bindReadingControl?.({
    pauseReading: () => {
      sinkPaused = true
      translator?.setPermissionNoticePaused?.(true)
      connection.pauseReading?.()
    },
    resumeReading: () => {
      sinkPaused = false
      translator?.setPermissionNoticePaused?.(false)
      const retried = retryOwedWritesOnDrain(translator)
      if (!sinkPaused && (retried.accepted || retried.reason !== 'backpressure')) {
        resume()
      }
    }
  })
  return () => {
    unbindDelivery?.()
    unbindSink?.()
  }
}

export function bindClaudeConnectionJournalControls(
  sink: StructuredAgentSessionEventSink | undefined,
  connection: ClaudeStreamJsonConnection,
  translator: ClaudeJournalTranslator | null,
  capture: ClaudeContextUsageCaptureOptions,
  delivery?: ClaudeJournalBoundDelivery
): (() => void) | undefined {
  const unbinds = [
    bindClaudeJournalReadingControl(sink, connection, translator, delivery),
    bindClaudeContextUsageCapture(connection, translator, capture)
  ].filter((unbind): unbind is () => void => unbind !== undefined)
  return unbinds.length === 0
    ? undefined
    : () => {
        for (const unbind of unbinds) {
          unbind()
        }
      }
}
