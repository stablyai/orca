import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalQuestionItem,
  AgentJournalTurnScope
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
  turnScope: AgentJournalTurnScope
}

type ClaudeJournalPromptEntry = {
  items: ClaudeJournalPrompt[]
  cancellationPending: boolean
  /** Journal producer ID; absent for the session's own agent. */
  asker?: string
  /** Waiting status requires a durable prompt card. */
  written: boolean
  landed?: Promise<void>
}

export type ClaudeOpenPromptCard = { promptKey: string; asker: string }

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
      turnScope: () => AgentJournalTurnScope
      bindPromptItemId?: (journalItemId: string, promptKey: string) => void
      questionItems?: (input: {
        sessionId: string
        prompt: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>['prompt']
      }) => ClaudeQuestionItem[]
      producerOf?: (
        prompt: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>['prompt']
      ) => AgentJournalProducerLinkage
    }
  ) {}

  /** Attribute the card to its asker; any pending card still puts the session in attention. */
  handle(event: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>): void {
    const producer = this.deps.producerOf?.(event.prompt) ?? {}
    const items: ClaudeJournalPrompt[] = []
    const turnScope = this.deps.turnScope()
    let admitted = true
    const append = (identity: AgentJournalItemIdentity, body: ClaudeJournalPrompt['body']) => {
      const options = { ...producer, turnScope }
      if (this.deps.sink.tryAppendItem) {
        const admission = this.deps.sink.tryAppendItem(identity, body, options)
        admitted &&= admission.accepted
      } else {
        this.deps.sink.appendItem(identity, body, options)
      }
    }
    if (event.prompt.kind === 'question') {
      for (const question of (this.deps.questionItems ?? claudeQuestionItems)({
        sessionId: event.sessionId,
        prompt: event.prompt
      })) {
        items.push({ ...question, turnScope })
        append(question.identity, question.body)
        this.deps.bindPromptItemId?.(agentJournalItemKey(question.identity), event.prompt.promptKey)
      }
    } else {
      const identity = claudePromptIdentity({
        sessionId: event.sessionId,
        promptKey: event.prompt.promptKey
      })
      const body = claudeApprovalItem(event.prompt)
      items.push({ identity, body, turnScope })
      append(identity, body)
      this.deps.bindPromptItemId?.(agentJournalItemKey(identity), event.prompt.promptKey)
    }
    this.deletePrompt(event.prompt.promptKey)
    const entry: ClaudeJournalPromptEntry = {
      items,
      cancellationPending: false,
      ...(producer.agentId ? { asker: producer.agentId } : {}),
      written: false
    }
    this.items.set(event.prompt.promptKey, entry)
    this.deps.sink.publish()
    if (admitted) {
      this.markWritten(entry)
    }
  }

  // Sinks without write barriers are treated as synchronous.
  private markWritten(entry: ClaudeJournalPromptEntry): void {
    const written = this.deps.sink.written?.()
    if (!written) {
      entry.written = true
      return
    }
    entry.landed = written.then((barrier) => {
      entry.written = barrier.ok
    })
  }

  /** No promise for synchronous writes or closed cards; a settled promise can indicate failure. */
  whenWritten(promptKey: string): Promise<void> | undefined {
    return this.items.get(promptKey)?.landed
  }

  private admitCancellation(promptKey: string): StructuredAgentSessionSinkAdmission {
    const items = this.items.get(promptKey)?.items ?? []
    if (items.length === 0) {
      return ADMITTED
    }
    const mutations = items.map(({ identity, body, turnScope }) => ({
      kind: 'item' as const,
      identity,
      body: cancelledPromptBody(body),
      turnScope
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
      const options = { lifecycle: true, turnScope: item.turnScope }
      admission = this.deps.sink.tryAppendItem
        ? this.deps.sink.tryAppendItem(item.identity, body, options)
        : (this.deps.sink.appendItem(item.identity, body, options), ADMITTED)
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

  retryPendingCancellations(): StructuredAgentSessionSinkAdmission {
    if (this.pendingCancellationTotal === 0) {
      return ADMITTED
    }
    for (const [promptKey, entry] of this.items) {
      if (!entry.cancellationPending) {
        continue
      }
      const admission = this.admitCancellation(promptKey)
      if (!admission.accepted && admission.reason === 'backpressure') {
        return admission
      }
      const retained = this.items.get(promptKey)
      if (retained) {
        this.setCancellationPending(retained, false)
      }
    }
    return ADMITTED
  }

  resolve(promptKey: string): void {
    this.deletePrompt(promptKey)
  }

  *openCards(): IterableIterator<ClaudeOpenPromptCard> {
    for (const [promptKey, entry] of this.items) {
      if (entry.written && entry.asker !== undefined) {
        yield { promptKey, asker: entry.asker }
      }
    }
  }

  /** Transfer cancellation ownership to the host; undo if its journal commit fails. */
  handOver(promptKey: string): () => void {
    const entry = this.items.get(promptKey)
    this.deletePrompt(promptKey)
    return () => {
      if (entry && !this.items.has(promptKey)) {
        // Reuse the entry so an in-flight write updates the restored card.
        entry.cancellationPending = false
        this.items.set(promptKey, entry)
      }
    }
  }

  clear(): void {
    this.items.clear()
    this.pendingCancellationTotal = 0
  }
}
