// The line under each message the host recorded and then did not deliver: the desktop row's words,
// in English. Only the transcript says it, so the phone's own send never repeats it in a banner.

import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { structuredAgentSessionRecordedRejectionParts } from '../../../src/shared/structured-agent-session-rejection-words'
import { structuredAgentSessionStartFailureFacts } from '../../../src/shared/structured-agent-session-start-failure-facts'

const NO_NOTICES: ReadonlyMap<string, string> = new Map()

/** Keyed by the message id the transcript renders each recorded send under. */
export function mobileNativeChatUnsentNotices(
  journal: NativeChatTurnJournal | null,
  agent: string | null
): ReadonlyMap<string, string> {
  const rejected = journal?.submissions.filter((row) => row.dispatchState === 'rejected') ?? []
  if (!journal || rejected.length === 0) {
    return NO_NOTICES
  }
  const startFailures = structuredAgentSessionStartFailureFacts(journal.items)
  const context = agent ? { agentName: formatAgentTypeLabel(agent) } : {}
  return new Map(
    rejected.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionRecordedRejectionParts(submission, context, startFailures)
      )
    ])
  )
}
