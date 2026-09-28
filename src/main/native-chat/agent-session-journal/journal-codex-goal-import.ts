import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import {
  codexGoalJournalDigest,
  codexGoalJournalIdentity
} from '../../codex/codex-goal-journal-identity'

/** Keep the source occurrence stable across catchup replays, while live resume recognizes its signature. */
export function codexGoalTranscriptIdentity(
  message: NativeChatMessage,
  sessionId: string
): AgentJournalItemIdentity | undefined {
  const goal = message.codexGoal
  return goal
    ? codexGoalJournalIdentity(
        codexGoalJournalDigest(goal.threadId || sessionId),
        goal.signature,
        codexGoalJournalDigest(`transcript:${message.id}`)
      )
    : undefined
}
