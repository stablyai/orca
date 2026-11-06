import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { CodexJournalTranslatorDeps } from '../journal/codex-structured-journal-contracts'
import type { CodexStructuredNotificationRetry } from '../session-lifecycle/codex-structured-notification-retry'
import type {
  CodexAcquisitionAttempt,
  CodexSession
} from '../session-lifecycle/codex-structured-session-state'
import type { CodexStructuredSessionTeardown } from '../session-lifecycle/codex-structured-session-teardown'

/** Scheduled plan saves run after their provider caller returns, so they re-check the owner. */
export function codexAcquisitionScheduledOwner(
  owners: {
    input: StructuredAgentSessionAcquireInput
    sessions: Map<string, CodexSession>
    notificationRetries: CodexStructuredNotificationRetry
    forceCloseUnexpected: CodexStructuredSessionTeardown['forceCloseUnexpected']
  },
  acquisition: CodexAcquisitionAttempt['window'],
  acquisitionGeneration: string
): Required<Pick<CodexJournalTranslatorDeps, 'isCurrent' | 'onScheduledFailure'>> {
  const { sessionId } = owners.input.identity
  const { fence } = owners.input
  const owner = (): CodexSession | undefined => {
    const session = owners.sessions.get(sessionId)
    return session &&
      session.connection === acquisition.connection &&
      session.fence === fence &&
      session.acquisitionGeneration === acquisitionGeneration &&
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
      owners.notificationRetries.clear(sessionId, session.connection)
      session.connection.resumeReading?.()
      void owners.forceCloseUnexpected(
        sessionId,
        fence,
        acquisitionGeneration,
        new Error(`scheduled plan admission failed (${admission.reason})`)
      )
    }
  }
}
