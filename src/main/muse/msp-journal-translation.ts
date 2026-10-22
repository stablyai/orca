// MSP provider events into Orca journal rows: messages, tool calls, approvals,
// questions, turn lifecycle, and a generic status row for what this build does
// not model yet (MSP item kinds are additive-open).

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem,
  type AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { MspPromptTranslator } from './msp-prompt-translation'
import { MspTurnTranslator } from './msp-turn-translation'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { MspItem, MspItemDeltaEvent, MspItemEvent, MspTurnEvent } from './msp-protocol'
import { mspItemText } from './msp-session'
import { sha256Hex } from './msp-protocol'

export type MspJournalIdentity = Extract<AgentJournalItemIdentity, { provider: 'muse' }>

export function mspItemIdentity(sessionId: string, itemId: string): MspJournalIdentity {
  return { provider: 'muse', sessionId, itemId }
}

function boundedPayload(text: string): {
  head: string
  byteLength: number
  digest: string
  truncated: boolean
} {
  const bytes = Buffer.byteLength(text, 'utf8')
  const head = text.slice(0, 8000)
  return {
    head,
    byteLength: bytes,
    digest: sha256Hex(text),
    truncated: bytes > Buffer.byteLength(head, 'utf8')
  }
}

export type MspTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  sessionId: string
  now?: () => number
}

export class MspJournalTranslator {
  private readonly texts = new Map<string, string>()
  private readonly turnScopes = new Map<string, AgentJournalItemIdentity>()
  private readonly turns: MspTurnTranslator
  private readonly prompts: MspPromptTranslator

  constructor(private readonly deps: MspTranslatorDeps) {
    this.turns = new MspTurnTranslator(deps.sink, deps.sessionId, () => this.now())
    this.prompts = new MspPromptTranslator(
      deps.sink,
      deps.sessionId,
      (turnId) => this.turnScope(turnId),
      () => this.now()
    )
  }

  private get sink(): StructuredAgentSessionEventSink {
    return this.deps.sink
  }

  private get sessionId(): string {
    return this.deps.sessionId
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private turnScope(turnId: string): { kind: 'turn'; turnItemId: string } {
    return {
      kind: 'turn',
      turnItemId: agentJournalItemKey(mspItemIdentity(this.sessionId, `turn:${turnId}`))
    }
  }

  writeUserMessage(clientMessageId: string, blocks: NativeChatBlock[], turnId: string): void {
    const identity = mspItemIdentity(this.sessionId, `user:${clientMessageId}`)
    const scope = this.turnScope(turnId)
    this.turnScopes.set(turnId, identity)
    const body: AgentJournalMessageItem = { kind: 'message', role: 'user', blocks }
    this.sink.tryAppendItem?.(identity, body, { turnScope: scope })
    this.sink.publish()
  }

  openTurn(turnId: string, input: { requestedAt?: number; userItemId?: string } = {}): void {
    this.turns.openTurn(turnId, input)
  }

  closeTurn(event: MspTurnEvent, outcome?: AgentJournalTurnOutcome): void {
    this.turns.closeTurn(event, outcome)
  }

  failTurn(turnId: string, reason: string): void {
    this.turns.failTurn(turnId, reason)
  }

  itemStarted(event: MspItemEvent): void {
    const { item } = event
    if (item.kind === 'userMessage') {
      // The dispatch already journaled the user row; the echo carries no payloads.
      return
    }
    if (item.kind === 'agentMessage') {
      this.texts.set(item.itemId, '')
      this.appendMessage(item, '', 'running')
      return
    }
    if (item.kind === 'toolCall') {
      this.appendToolCall(item)
      return
    }
    if (item.kind !== 'approval' && item.kind !== 'question') {
      // Approvals and questions arrive as server requests; the item echo only
      // carries their display side once the prompt row exists.
      this.appendProviderFrame(item)
    }
  }

  itemDelta(event: MspItemDeltaEvent): void {
    if (event.field !== 'text' && event.field !== 'output') {
      return
    }
    const current = this.texts.get(event.itemId) ?? ''
    const next = current + event.delta
    this.texts.set(event.itemId, next)
    this.reviseText(event.itemId, next, 'running')
  }

  itemUpdated(event: MspItemEvent): void {
    const { item } = event
    if (item.kind === 'toolCall') {
      this.reviseToolCall(item)
    }
  }

  itemCompleted(event: MspItemEvent): void {
    const { item } = event
    switch (item.kind) {
      case 'userMessage':
        return
      case 'agentMessage': {
        const text = this.texts.get(item.itemId) ?? mspItemText(item)
        this.texts.delete(item.itemId)
        this.reviseText(item.itemId, text, 'completed')
        this.sink.publish()
        return
      }
      case 'toolCall':
        this.reviseToolCall(item, true)
        this.sink.publish()
        return
      case 'reasoning':
        this.texts.delete(item.itemId)
        return
      default:
        this.sink.publish()
    }
  }

  writeApprovalRow(
    approvalId: string,
    itemId: string,
    turnId: string,
    row: Extract<AgentJournalItemBody, { kind: 'approval' }>
  ): void {
    void approvalId
    this.prompts.writeApprovalRow(itemId, turnId, row)
  }

  writeQuestionRow(
    userInputId: string,
    itemId: string,
    turnId: string,
    row: Extract<AgentJournalItemBody, { kind: 'question' }>
  ): void {
    void userInputId
    this.prompts.writeQuestionRow(itemId, turnId, row)
  }

  resolvePromptRow(
    itemId: string,
    turnId: string,
    resolution: { state: 'resolved' | 'cancelled'; selectedOptionId: string | null }
  ): void {
    this.prompts.resolvePromptRow(itemId, turnId, resolution)
  }

  private appendMessage(item: MspItem, text: string, state: 'running' | 'completed'): void {
    const turnId = item.turnId ?? 'unknown'
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      state,
      ...(state === 'running' ? {} : { completedAt: this.now() })
    }
    this.sink.tryAppendItem?.(mspItemIdentity(this.sessionId, item.itemId), body, {
      turnScope: this.turnScope(turnId)
    })
    this.sink.publish()
  }

  private reviseText(itemId: string, text: string, state: 'running' | 'completed'): void {
    const identity = mspItemIdentity(this.sessionId, itemId)
    const sink = this.sink
    if (!sink.tryReviseResolvedItem) {
      return
    }
    const at = this.now()
    sink.tryReviseResolvedItem(
      Buffer.byteLength(text, 'utf8') + 512,
      (journal) => {
        const current = journal.itemBody(agentJournalItemKey(identity))
        if (!current || current.kind !== 'message') {
          return null
        }
        return {
          identity,
          body: {
            ...current,
            blocks: [{ type: 'text', text }],
            state,
            ...(state === 'running' ? {} : { completedAt: at })
          }
        }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }

  private appendToolCall(item: MspItem): void {
    const turnId = item.turnId ?? 'unknown'
    let input: unknown = item.args ?? null
    if (typeof item.args === 'string') {
      try {
        input = JSON.parse(item.args)
      } catch {
        input = item.args
      }
    }
    this.sink.tryAppendItem?.(
      mspItemIdentity(this.sessionId, item.itemId),
      {
        kind: 'tool-call',
        name: item.name ?? 'tool',
        input,
        ...(item.callId ? { callId: item.callId } : {}),
        state: item.status === 'failed' ? 'failed' : 'running'
      },
      { turnScope: this.turnScope(turnId) }
    )
    this.sink.publish()
  }

  private reviseToolCall(item: MspItem, finished = false): void {
    const identity = mspItemIdentity(this.sessionId, item.itemId)
    const sink = this.sink
    if (!sink.tryReviseResolvedItem) {
      return
    }
    const turnId = item.turnId ?? 'unknown'
    sink.tryReviseResolvedItem(
      8192,
      (journal) => {
        const current = journal.itemBody(agentJournalItemKey(identity))
        if (!current || current.kind !== 'tool-call') {
          return null
        }
        const text = mspItemText(item) || item.output || ''
        return {
          identity,
          body: {
            ...current,
            state: item.status === 'failed' ? 'failed' : finished ? 'completed' : 'running',
            ...(text
              ? { output: boundedPayload(text) }
              : current.output
                ? { output: current.output }
                : {})
          }
        }
      },
      { turnScope: this.turnScope(turnId) }
    )
  }

  private appendProviderFrame(item: MspItem): void {
    const turnId = item.turnId ?? 'unknown'
    const text = mspItemText(item) || `${item.kind} ${item.status ?? ''}`.trim()
    if (item.kind === 'reasoning' && text) {
      this.texts.set(item.itemId, text)
    }
    const body: AgentJournalItemBody = {
      kind: 'status',
      text: text || item.kind,
      providerFrame: {
        provider: 'muse',
        kind: item.kind,
        payload: boundedPayload(text || item.kind)
      }
    }
    this.sink.tryAppendItem?.(mspItemIdentity(this.sessionId, item.itemId), body, {
      turnScope: this.turnScope(turnId)
    })
    this.sink.publish()
  }
}
