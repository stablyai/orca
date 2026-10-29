import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'
import { agentSessionVisibleFailureFacts } from '../../../src/shared/agent-session-visible-failures'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionRecordedRejectionParts } from '../../../src/shared/structured-agent-session-rejection-words'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'

const NO_NOTICES: ReadonlyMap<string, string> = new Map()

// Share the empty result during streaming; Stop withdrawals are not send failures.
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
      mobileAgentSessionWriteNoticeText(
        structuredAgentSessionRecordedRejectionParts(submission, { agentName }, startFailures)
      )
    ])
  )
}
