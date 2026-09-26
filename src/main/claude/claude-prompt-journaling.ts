// Journaling an approval or question prompt, and remembering the rows it wrote
// so a cancellation can tombstone exactly those.

import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeApprovalItem,
  claudePromptIdentity,
  claudeQuestionItems
} from './claude-structured-prompt-items'

export type ClaudePromptJournalDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string) => void
  /** Prompt key → the rows it wrote, owned by the translator so a cancel can sweep them. */
  promptItems: Map<string, AgentJournalItemIdentity[]>
}

export function journalClaudePrompt(
  deps: ClaudePromptJournalDeps,
  event: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>
): void {
  const identities: AgentJournalItemIdentity[] = []
  if (event.prompt.kind === 'question') {
    for (const question of claudeQuestionItems({
      sessionId: event.sessionId,
      prompt: event.prompt
    })) {
      identities.push(question.identity)
      deps.sink.appendItem(question.identity, question.body)
      deps.bindPromptItemId?.(agentJournalItemKey(question.identity), event.prompt.promptKey)
    }
  } else {
    const identity = claudePromptIdentity({
      sessionId: event.sessionId,
      promptKey: event.prompt.promptKey
    })
    identities.push(identity)
    deps.sink.appendItem(identity, claudeApprovalItem(event.prompt))
    deps.bindPromptItemId?.(agentJournalItemKey(identity), event.prompt.promptKey)
  }
  deps.promptItems.set(event.prompt.promptKey, identities)
  deps.sink.publish()
}
