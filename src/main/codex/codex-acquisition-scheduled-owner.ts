import type { CodexJournalTranslatorDeps } from './codex-structured-journal-contracts'
import type { CodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { CodexAcquisitionAttempt, CodexSession } from './codex-structured-session-state'
import type { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'

/** Scheduled plan saves run after their provider caller returns, so they re-check the owner. */
export function codexAcquisitionScheduledOwner(input: {
  sessions: Map<string, CodexSession>
  sessionId: string
  acquisition: CodexAcquisitionAttempt['window']
  fence: number
  acquisitionGeneration: string
  notificationRetries: CodexStructuredNotificationRetry
  forceCloseUnexpected: CodexStructuredSessionTeardown['forceCloseUnexpected']
}): Required<Pick<CodexJournalTranslatorDeps, 'isCurrent' | 'onScheduledFailure'>> {
  const owner = (): CodexSession | undefined => {
    const session = input.sessions.get(input.sessionId)
    return session &&
      session.connection === input.acquisition.connection &&
      session.fence === input.fence &&
      session.acquisitionGeneration === input.acquisitionGeneration &&
      !session.ended &&
      !session.orcaClose
      ? session
      : undefined
  }
  return {
    isCurrent: () => owner() !== undefined,
    onScheduledFailure: (admission) => {
      const session = owner()
      if (!session) {
        return
      }
      input.notificationRetries.clear(input.sessionId, session.connection)
      session.connection.resumeReading?.()
      void input.forceCloseUnexpected(
        input.sessionId,
        input.fence,
        input.acquisitionGeneration,
        new Error(`scheduled plan admission failed (${admission.reason})`)
      )
    }
  }
}
