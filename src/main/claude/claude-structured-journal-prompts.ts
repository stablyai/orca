import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  claudeApprovalItem,
  claudePromptIdentity,
  claudeQuestionItems,
  type ClaudeQuestionItem
} from './claude-structured-prompt-items'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

const ADMITTED = { accepted: true } as const

type ClaudeJournalPrompt = {
  identity: AgentJournalItemIdentity
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
}

type ClaudeJournalPromptEntry = {
  items: ClaudeJournalPrompt[]
  cancellationPending: boolean
}

function cancelledPromptBody(
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
): AgentJournalApprovalItem | AgentJournalQuestionItem {
  const cancelled = cancelledJournalPromptBody(body)
  if (!cancelled) {
    throw new Error('Claude prompt body is not cancellable')
  }
  return cancelled
}

export class ClaudeJournalPrompts {
  private readonly items = new Map<string, ClaudeJournalPromptEntry>()
  private pendingCancellationTotal = 0

  get size(): number {
    return this.items.size
  }

  get pendingCancellationCount(): number {
    return this.pendingCancellationTotal
  }

  constructor(
    private readonly deps: {
      sink: StructuredAgentSessionEventSink
      bindPromptItemId?: (journalItemId: string, promptKey: string, questionId?: string) => void
      questionItems?: (input: {
        sessionId: string
        prompt: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>['prompt']
      }) => ClaudeQuestionItem[]
    }
  ) {}

  /**
   * Prompt rows carry NO producer linkage, and cannot.
   *
   * A prompt is not a transcript frame: it reaches Orca through the SDK's
   * permission callback, whose options carry a request id and the tool awaiting
   * approval and no parent reference of any kind. So when a subagent asks, the
   * row cannot name it — unattributable at this site, not deliberately root.
   *
   * No reader is wrong because of it. A pending prompt projects the session as
   * `attention` whoever raised it, which is the truth: the USER has to answer.
   */
  handle(event: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>): void {
    const items: ClaudeJournalPrompt[] = []
    if (event.prompt.kind === 'question') {
      for (const question of (this.deps.questionItems ?? claudeQuestionItems)({
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
    this.deletePrompt(event.prompt.promptKey)
    this.items.set(event.prompt.promptKey, { items, cancellationPending: false })
    this.deps.sink.publish()
  }

  private admitCancellation(promptKey: string): StructuredAgentSessionSinkAdmission {
    const items = this.items.get(promptKey)?.items ?? []
    if (items.length === 0) {
      return ADMITTED
    }
    const mutations = items.map(({ identity, body }) => ({
      kind: 'item' as const,
      identity,
      body: cancelledPromptBody(body)
    }))
    let admission: StructuredAgentSessionSinkAdmission
    if (this.deps.sink.tryAppendLifecycleBatch) {
      admission = this.deps.sink.tryAppendLifecycleBatch(
        `prompt-cancelled:${encodeURIComponent(promptKey)}`,
        mutations,
        { lifecycle: true }
      )
    } else if (this.deps.sink.appendLifecycleBatch) {
      admission =
        this.deps.sink.appendLifecycleBatch(
          `prompt-cancelled:${encodeURIComponent(promptKey)}`,
          mutations,
          { lifecycle: true }
        ) ?? ADMITTED
    } else if (items.length === 1) {
      const item = items[0]
      if (!item) {
        return ADMITTED
      }
      const body = cancelledPromptBody(item.body)
      admission = this.deps.sink.tryAppendItem
        ? this.deps.sink.tryAppendItem(item.identity, body, { lifecycle: true })
        : (this.deps.sink.appendItem(item.identity, body, { lifecycle: true }), ADMITTED)
    } else {
      return { accepted: false, reason: 'failed' }
    }
    if (!admission.accepted) {
      return admission
    }
    const published = this.deps.sink.tryPublish
      ? this.deps.sink.tryPublish({ lifecycle: true })
      : (this.deps.sink.publish({ lifecycle: true }), ADMITTED)
    if (published.accepted) {
      this.deletePrompt(promptKey)
    }
    return published
  }

  private deletePrompt(promptKey: string): void {
    const entry = this.items.get(promptKey)
    if (entry?.cancellationPending) {
      this.pendingCancellationTotal -= 1
    }
    this.items.delete(promptKey)
  }

  private setCancellationPending(entry: ClaudeJournalPromptEntry, pending: boolean): void {
    if (entry.cancellationPending === pending) {
      return
    }
    entry.cancellationPending = pending
    this.pendingCancellationTotal += pending ? 1 : -1
  }

  cancel(promptKey: string): StructuredAgentSessionSinkAdmission {
    const admission = this.admitCancellation(promptKey)
    const entry = this.items.get(promptKey)
    if (entry) {
      this.setCancellationPending(entry, !admission.accepted && admission.reason === 'backpressure')
    }
    return admission
  }

  retryPendingCancellations(): void {
    if (this.pendingCancellationTotal === 0) {
      return
    }
    for (const [promptKey, entry] of this.items) {
      if (!entry.cancellationPending) {
        continue
      }
      const admission = this.admitCancellation(promptKey)
      if (!admission.accepted && admission.reason === 'backpressure') {
        return
      }
      const retained = this.items.get(promptKey)
      if (retained) {
        this.setCancellationPending(retained, false)
      }
    }
  }

  resolve(promptKey: string): void {
    this.deletePrompt(promptKey)
  }

  clear(): void {
    this.items.clear()
    this.pendingCancellationTotal = 0
  }
}
