import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createLegacyProviderTimelineIdentityScheme } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import {
  providerKey,
  ProviderTimelineRows
} from '../../../native-chat/agent-session-timeline/provider-timeline-rows'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { AcpSessionEvent } from '../../protocol/acp-session-events'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AcpTimelineTranslator } from '../../timeline/acp-timeline-translator'
import { acpNamedTextKey } from '../../timeline/acp-turn-messages'
import { AcpSavedTextOverlap } from './acp-saved-text-overlap'

import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'

type SavedRow = (itemId: string) => Promise<AgentJournalRenderItem | null>

/** The provider item a text chunk or call update continues, when the earlier app may have saved it. */
function continuedItem(event: AcpSessionEvent): { key: string; text?: string } | null {
  if (event.kind !== 'known') {
    return null
  }
  const { update } = event.notification
  if (update.sessionUpdate === 'tool_call_update') {
    return { key: `tool:${update.toolCallId}` }
  }
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk') &&
    update.messageId &&
    update.content.type === 'text'
  ) {
    const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
    return { key: acpNamedTextKey(update.messageId, channel), text: update.content.text }
  }
  return null
}

const SAVED_TEXT_WAIT_MS = 100

function savedText(saved: AgentJournalRenderItem | null): string {
  return saved?.body.kind === 'message'
    ? saved.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

/** The chunk carrying `text` in place of its own, so the stream's snapshot is the whole message. */
function withText(event: AcpSessionEvent, text: string): AcpSessionEvent {
  if (event.kind !== 'known') {
    return event
  }
  const { update } = event.notification
  if (
    (update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk') ||
    update.content.type !== 'text'
  ) {
    return event
  }
  const content = { ...update.content, text }
  return { ...event, notification: { ...event.notification, update: { ...update, content } } }
}

/** A saved message's first replayed chunks, held until it is known which of them were saved. */
type HeldText = { key: string; event: AcpSessionEvent; overlap: AcpSavedTextOverlap }

/**
 * A kept agent's updates to a message or call the earlier app saved, during the turn it carries
 * on. This run's translator has seen neither, and a text or call write replaces the saved row
 * whole, so the first update to each waits for that row once and continues it: a call keeps what
 * was saved, and a message reads the saved text then the replay, without the chunks it already
 * held. Every update keeps its order behind a wait. Ends with the carried turn; after that
 * nothing is read.
 */
export class AcpKeptRows {
  private readonly seen = new Set<string>()
  private readonly queue: AcpSessionEvent[] = []
  private head = 0
  private reading = false
  private held: HeldText | null = null
  private heldTimer: ReturnType<typeof setTimeout> | null = null
  private ended = false
  private deliver: (event: AcpSessionEvent) => void = () => {}
  private readonly idle: (() => void)[] = []

  constructor(
    private readonly deps: {
      agent: AgentType
      sessionId: string
      translator: () => AcpTimelineTranslator | undefined
      read: SavedRow
    }
  ) {}

  end(): void {
    this.ended = true
    this.seen.clear()
    this.release()
  }

  /** Resolves once every update routed so far has reached the chat. */
  drained(): Promise<void> {
    this.release()
    return this.reading || this.head < this.queue.length
      ? new Promise((resolve) => this.idle.push(resolve))
      : Promise.resolve()
  }

  route(deliver: (event: AcpSessionEvent) => void): (event: AcpSessionEvent) => void {
    this.deliver = deliver
    return (event) => {
      this.queue.push(event)
      this.pump()
    }
  }

  private pump(): void {
    while (!this.reading && this.head < this.queue.length) {
      const event = this.queue[this.head++]!
      const translator = this.deps.translator()
      const item = this.ended || !translator ? null : continuedItem(event)
      if (this.held && item?.key === this.held.key && item.text !== undefined) {
        this.holdText(this.held.overlap.add(item.text))
        continue
      }
      this.release()
      const update = event.kind === 'known' ? event.notification.update : null
      // A call this run saw begin has nothing saved before it.
      if (!this.ended && update?.sessionUpdate === 'tool_call') {
        this.seen.add(`tool:${update.toolCallId}`)
      }
      if (!translator || !item || this.seen.has(item.key)) {
        this.deliver(event)
        continue
      }
      this.seen.add(item.key)
      this.reading = true
      void this.deps
        .read(this.rowId(translator, item.key))
        .catch(() => null)
        .then((saved) => {
          this.reading = false
          if (saved?.body.kind === 'tool-call') {
            translator.carryTool(saved.body)
          }
          const text = savedText(saved)
          if (text && item.text !== undefined) {
            this.held = { key: item.key, event, overlap: new AcpSavedTextOverlap(text) }
            this.holdText(this.held.overlap.add(item.text))
          } else {
            this.deliver(event)
          }
          this.pump()
        })
    }
    if (this.head === this.queue.length) {
      this.queue.length = 0
      this.head = 0
    }
    if (!this.reading && this.head === this.queue.length && !this.held) {
      this.idle.splice(0).forEach((resolve) => resolve())
    }
  }

  /** Known: the held chunks go as one; else they wait a moment for the next chunk to tell. */
  private holdText(known: string | null): void {
    if (known !== null) {
      this.deliverHeld(known)
      return
    }
    this.clearHeldTimer()
    this.heldTimer = setTimeout(() => {
      this.release()
      this.pump()
    }, SAVED_TEXT_WAIT_MS)
    this.heldTimer.unref?.()
  }

  /** Held chunks go as new text when no further chunk can tell. */
  private release(): void {
    if (this.held) {
      this.deliverHeld(this.held.overlap.settle())
    }
  }

  private deliverHeld(text: string): void {
    const held = this.held
    this.held = null
    this.clearHeldTimer()
    if (held) {
      this.deliver(withText(held.event, text))
    }
  }

  private clearHeldTimer(): void {
    if (this.heldTimer) {
      clearTimeout(this.heldTimer)
      this.heldTimer = null
    }
  }

  private rowId(translator: AcpTimelineTranslator, key: string): string {
    const namespace = translator.providerSessionId
    const rows = new ProviderTimelineRows({
      scheme: createLegacyProviderTimelineIdentityScheme(this.deps),
      generation: '',
      namespace
    })
    return rows.item('item', providerKey(key), namespace).itemId
  }
}

/** The gate for a kept agent's chat, reading saved rows from its journal; null for a fresh agent. */
export function keptAcpRows(
  kept: unknown,
  events: StructuredAgentSessionEventSink | undefined,
  chat: {
    deps: Pick<AcpStructuredSessionAdapterDeps, 'spec'>
    acquire: Pick<StructuredAgentSessionAcquireInput, 'identity'>
  },
  translator: () => AcpTimelineTranslator | undefined
): AcpKeptRows | null {
  return kept && events
    ? new AcpKeptRows({
        agent: chat.deps.spec.agent,
        sessionId: chat.acquire.identity.sessionId,
        translator,
        read: async (itemId) =>
          (await events.journalHistory?.()?.readInOrder((reads) => reads.itemDetail(itemId))) ??
          null
      })
    : null
}
