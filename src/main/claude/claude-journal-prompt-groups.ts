import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeApprovalItem,
  claudePromptIdentity,
  claudeQuestionItems
} from './claude-structured-prompt-items'

type PromptEvent = Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>
type PromptCancellationEvent = Extract<ClaudeStructuredSessionEvent, { type: 'prompt-cancelled' }>
type PromptItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

export class ClaudeJournalPromptGroups {
  private readonly groups = new Map<string, { toolUseId: string; items: PromptItem[] }>()

  constructor(
    private readonly deps: {
      sink: StructuredAgentSessionEventSink
      bindPromptItemId?: (journalItemId: string, promptKey: string, questionId?: string) => void
    }
  ) {}

  get size(): number {
    return this.groups.size
  }

  append(event: PromptEvent): void {
    const items: PromptItem[] = []
    if (event.prompt.kind === 'question') {
      for (const question of claudeQuestionItems({
        sessionId: event.sessionId,
        prompt: event.prompt
      })) {
        items.push(question)
        this.deps.sink.appendItem(question.identity, question.body)
        this.deps.bindPromptItemId?.(agentJournalItemKey(question.identity), event.prompt.promptKey)
      }
    } else {
      const identity = claudePromptIdentity({
        sessionId: event.sessionId,
        promptKey: event.prompt.promptKey
      })
      const body = claudeApprovalItem(event.prompt)
      items.push({ identity, body })
      this.deps.sink.appendItem(identity, body)
      this.deps.bindPromptItemId?.(agentJournalItemKey(identity), event.prompt.promptKey)
    }
    this.groups.set(event.prompt.promptKey, { toolUseId: event.prompt.toolUseId, items })
    this.deps.sink.publish()
  }

  cancel(event: PromptCancellationEvent): void {
    const cancellations = (this.groups.get(event.promptKey)?.items ?? []).flatMap((item) => {
      const body = cancelledJournalPromptBody(item.body, {
        resolvedBy: event.resolvedBy,
        resolvedAt: event.resolvedAt,
        settlementId: event.settlementId
      })
      return body ? [{ kind: 'item' as const, identity: item.identity, body }] : []
    })
    if (cancellations.length > 0 && this.deps.sink.appendLifecycleBatch) {
      this.deps.sink.appendLifecycleBatch(
        event.settlementId ??
          `provider-prompt-cancel:${event.sessionId}:${encodeURIComponent(event.promptKey)}`,
        cancellations,
        { lifecycle: true }
      )
    } else {
      for (const cancellation of cancellations) {
        this.deps.sink.appendItem(cancellation.identity, cancellation.body, { lifecycle: true })
      }
    }
    this.groups.delete(event.promptKey)
    this.deps.sink.publish({ lifecycle: true })
  }

  forgetToolUse(toolUseId: string): void {
    for (const [promptKey, prompt] of this.groups) {
      if (prompt.toolUseId === toolUseId) {
        this.groups.delete(promptKey)
      }
    }
  }

  clear(): void {
    this.groups.clear()
  }
}
