import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'

export type CodexPendingJournalPrompt = {
  threadId: string
  turnId: string | null
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

export function collectCodexTurnPromptCancellations(input: {
  threadId: string
  turnId: string
  pendingPrompts: ReadonlyMap<string, CodexPendingJournalPrompt>
}): { mutations: JournalLifecycleMutationInput[]; itemIds: string[] } {
  const mutations: JournalLifecycleMutationInput[] = []
  const itemIds: string[] = []
  for (const [itemId, prompt] of input.pendingPrompts) {
    if (prompt.threadId !== input.threadId || prompt.turnId !== input.turnId) {
      continue
    }
    const body = cancelledJournalPromptBody(prompt.body)
    if (body) {
      mutations.push({ kind: 'item', identity: prompt.identity, body })
    }
    itemIds.push(itemId)
  }
  return { mutations, itemIds }
}
