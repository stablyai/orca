import type {
  AgentJournalApprovalItem,
  AgentJournalProducerLinkage,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_PERMISSION_FLOW_RESOLVER } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-resolver'
import { cancelledJournalPromptBody } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  claudeApprovalItem,
  claudePromptIdentity,
  claudeQuestionItems,
  type ClaudeQuestionItem
} from './claude-structured-prompt-items'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

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
  /** A tool permission's call: if it runs after Claude withdraws the card, something allowed it. */
  toolUseId?: string
}

type ClaudeWithdrawnApproval = {
  promptKey: string
  entry: ClaudeJournalPromptEntry
  prompt: ClaudeJournalPrompt
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
  /** By tool call: approvals Claude withdrew whose call has not reported a result yet. */
  private readonly withdrawn = new Map<string, ClaudeWithdrawnApproval>()
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
    let toolUseId: string | undefined
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
      // A plan review is not a tool permission.
      toolUseId = body.subject ? undefined : event.prompt.toolUseId
      items.push({ identity, body, turnScope })
      append(identity, body)
      this.deps.bindPromptItemId?.(agentJournalItemKey(identity), event.prompt.promptKey)
    }
    this.deletePrompt(event.prompt.promptKey)
    const entry: ClaudeJournalPromptEntry = {
      items,
      cancellationPending: false,
      ...(producer.agentId ? { asker: producer.agentId } : {}),
      written: false,
      ...(toolUseId ? { toolUseId } : {})
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
      admission = this.appendLifecycleItem(item, cancelledPromptBody(item.body))
    } else {
      return { accepted: false, reason: 'failed' }
    }
    if (!admission.accepted) {
      return admission
    }
    const published = this.publishLifecycle()
    if (published.accepted) {
      this.deletePrompt(promptKey)
    }
    return published
  }

  private appendLifecycleItem(
    prompt: ClaudeJournalPrompt,
    body: ClaudeJournalPrompt['body']
  ): StructuredAgentSessionSinkAdmission {
    const options = { lifecycle: true, turnScope: prompt.turnScope }
    return this.deps.sink.tryAppendItem
      ? this.deps.sink.tryAppendItem(prompt.identity, body, options)
      : (this.deps.sink.appendItem(prompt.identity, body, options), ADMITTED)
  }

  private publishLifecycle(): StructuredAgentSessionSinkAdmission {
    return this.deps.sink.tryPublish
      ? this.deps.sink.tryPublish({ lifecycle: true })
      : (this.deps.sink.publish({ lifecycle: true }), ADMITTED)
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
    const cancelled = this.items.get(promptKey)
    const prompt = cancelled?.items[0]
    if (cancelled?.toolUseId && prompt) {
      this.withdrawn.set(cancelled.toolUseId, { promptKey, entry: cancelled, prompt })
    }
    const admission = this.admitCancellation(promptKey)
    const entry = this.items.get(promptKey)
    if (entry) {
      this.setCancellationPending(entry, !admission.accepted && admission.reason === 'backpressure')
    }
    return admission
  }

  /** Claude withdraws its stdio request when a PermissionRequest hook answers first; a call that
   *  then succeeds was allowed, so its card reads allowed. A failed one may have been denied. */
  observeToolResult(toolUseId: string, failed: boolean, observedAt: number): void {
    const withdrawn = this.withdrawn.get(toolUseId)
    if (!withdrawn) {
      return
    }
    this.withdrawn.delete(toolUseId)
    const { prompt } = withdrawn
    const allow = prompt.body.options.find((option) => option.intent === 'allow_once')
    if (failed || !allow) {
      return
    }
    if (this.items.get(withdrawn.promptKey) === withdrawn.entry) {
      // A cancellation still held by backpressure would overwrite this answer.
      this.deletePrompt(withdrawn.promptKey)
    }
    const resolution = {
      state: 'resolved' as const,
      selectedOptionId: allow.id,
      resolvedBy: AGENT_PERMISSION_FLOW_RESOLVER,
      resolvedAt: observedAt
    }
    if (this.appendLifecycleItem(prompt, { ...prompt.body, resolution }).accepted) {
      this.publishLifecycle()
    }
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
    this.withdrawn.clear()
    this.pendingCancellationTotal = 0
  }
}
