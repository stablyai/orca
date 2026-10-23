// The line under each message the host recorded and then rejected, in the desktop's words.

import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import { agentSessionVisibleFailureFacts } from '../../../src/shared/agent-session-visible-failures'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionRecordedRejectionParts } from '../../../src/shared/structured-agent-session-rejection-words'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'

const NO_NOTICES: ReadonlyMap<string, string> = new Map()

/** By the row id the transcript draws each message under; shared and empty when no send failed (a
 *  Stop's withdrawal is no failure), so a streaming turn then pays nothing. */
export function mobileNativeChatUnsentNotices(
  journal: NativeChatTurnJournal | null,
  agent: string | null | undefined
): ReadonlyMap<string, string> {
  const rejected = (journal?.submissions ?? []).filter(
    (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
  )
  if (!journal || rejected.length === 0) {
    return NO_NOTICES
  }
  const startFailures = agentSessionVisibleFailureFacts(journal.items)
  const agentName = agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined
  return new Map(
    rejected.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionRecordedRejectionParts(submission, { agentName }, startFailures)
      )
    ])
  )
}
