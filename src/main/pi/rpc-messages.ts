import { z } from 'zod'
import { BoundedMap } from '../../shared/bounded-map'
import { MAX_PROVIDER_TIMELINE_OPEN_ENTRIES } from '../native-chat/agent-session-timeline/provider-timeline-budget'
import type { AgentJournalToolCallItem } from '../../shared/agent-session-journal-types'
import {
  boundToolInput,
  JOURNAL_RUNNING_PREVIEW_LIMITS,
  journalToolPayload
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { piRpcMessageEventSchema, piRpcToolEventSchema } from './rpc-protocol'
import type { PiRpcContextUsage } from './rpc-context-usage'

const resultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }))
})

/** One row per turn: a second close of the same item is dropped. */
export function piRpcSkippedEventNotice(turn: string): ProviderTimelineEvent {
  return {
    type: 'item.close',
    item: `oversized:${turn}`,
    body: {
      kind: 'status',
      tone: 'warning',
      text: 'Pi sent an update too large to show, so part of this turn is missing here.'
    }
  }
}

const PI_TEXT_CHANNELS: Partial<Record<string, 'assistant' | 'reasoning'>> = {
  text_delta: 'assistant',
  text_end: 'assistant',
  thinking_delta: 'reasoning',
  thinking_end: 'reasoning'
}

/** Pi does not name assistant messages; ordinals are local to this exact child. */
export class PiRpcMessages {
  private ordinal = 0
  private active?: number
  private readonly text = new Set<string>()
  /** Highest block index streamed in this message; Pi already closed those not still open. */
  private streamed = -1
  private readonly tools = new Map<string, AgentJournalToolCallItem>()
  // Closing events take these latest full fields; running journal rows retain only previews.
  private readonly whole = new BoundedMap<
    string,
    {
      input?: unknown
      output?: string
      inputBytes: number
      outputBytes: number
    }
  >({
    maxEntries: MAX_PROVIDER_TIMELINE_OPEN_ENTRIES,
    sizeOf: (value, key) => value.inputBytes + value.outputBytes + Buffer.byteLength(key) + 64
  })

  get retainedToolBytes(): number {
    return this.whole.retainedBytes
  }

  constructor(
    private readonly generation: string,
    private readonly context: PiRpcContextUsage
  ) {}

  reset(): void {
    this.active = undefined
    this.text.clear()
    this.streamed = -1
    this.tools.clear()
    this.whole.clear()
  }

  message(value: unknown, at: number): ProviderTimelineEvent[] {
    const parsed = piRpcMessageEventSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error('Invalid Pi message event')
    }
    const event = parsed.data
    const message = event.message ?? event.assistantMessageEvent?.partial
    if (message && message.role !== 'assistant') {
      return []
    }
    if (event.type === 'message_start') {
      this.active = ++this.ordinal
      this.text.clear()
      this.streamed = -1
      return []
    }
    const events = this.context.live(event.usage ?? message?.usage, at)
    this.active ??= ++this.ordinal
    const update = event.assistantMessageEvent
    const channel = update && PI_TEXT_CHANNELS[update.type]
    if (event.type === 'message_update' && update && channel) {
      const index = update.contentIndex ?? 0
      const item = this.key(index, channel)
      this.streamed = Math.max(this.streamed, index)
      if (update.type.endsWith('_end')) {
        // Pi ends each block before its message ends, so only concurrent blocks stay open.
        events.push(
          ...this.close(
            item,
            channel,
            typeof update.content === 'string' ? update.content : undefined
          )
        )
      } else if (update.delta !== undefined) {
        if (this.text.size >= 128 && !this.text.has(item)) {
          throw new Error('Pi message stream capacity exceeded')
        }
        this.text.add(item)
        events.push({ type: 'text.delta', item: { id: item }, channel, text: update.delta })
      }
    }
    if (event.type === 'message_end' && message) {
      const content =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content
      content.forEach((block, index) => {
        const channel =
          block.type === 'text' ? 'assistant' : block.type === 'thinking' ? 'reasoning' : undefined
        if (!channel) {
          return
        }
        const item = this.key(index, channel)
        if (index <= this.streamed && !this.text.has(item)) {
          return
        }
        const text = channel === 'assistant' ? block.text : block.thinking
        if (text !== undefined) {
          events.push(...this.close(item, channel, text))
        }
      })
      for (const item of this.text) {
        events.push({ type: 'text.close', item: { id: item } })
      }
      this.text.clear()
      this.streamed = -1
      this.active = undefined
    }
    return events
  }

  tool(value: unknown): ProviderTimelineEvent[] {
    const parsed = piRpcToolEventSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error('Invalid Pi tool event')
    }
    const event = parsed.data
    const previous = this.tools.get(event.toolCallId)
    const held = this.whole.get(event.toolCallId)
    const result = event.result ?? event.partialResult
    const content = resultSchema.safeParse(result)
    const output =
      result === undefined
        ? held?.output
        : content.success
          ? content.data.content
              .flatMap((block) => (block.text === undefined ? [] : [block.text]))
              .join('\n')
          : JSON.stringify(result)
    const state =
      event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'running'
    const input = event.args === undefined ? held?.input : event.args
    const body: AgentJournalToolCallItem = {
      kind: 'tool-call',
      name: event.toolName,
      callId: event.toolCallId,
      input:
        input === undefined
          ? (previous?.input ?? null)
          : state === 'running'
            ? event.args === undefined && previous
              ? previous.input
              : boundToolInput(input, JOURNAL_RUNNING_PREVIEW_LIMITS)
            : input,
      state,
      ...(output === undefined
        ? previous?.output
          ? { output: previous.output }
          : {}
        : {
            output:
              state === 'running' && result === undefined && previous?.output
                ? previous.output
                : journalToolPayload(output, state === 'running')
          })
    }
    if (state === 'running') {
      if (this.tools.size >= 128 && !previous) {
        throw new Error('Pi tool stream capacity exceeded')
      }
      this.tools.set(event.toolCallId, body)
      if (!held && this.whole.size >= MAX_PROVIDER_TIMELINE_OPEN_ENTRIES) {
        throw new Error('Pi tool stream capacity exceeded')
      }
      if (
        !this.whole.set(event.toolCallId, {
          input,
          output,
          inputBytes:
            event.args === undefined
              ? (held?.inputBytes ?? 0)
              : Buffer.byteLength(JSON.stringify(input) ?? ''),
          outputBytes:
            result === undefined
              ? (held?.outputBytes ?? 0)
              : Buffer.byteLength(JSON.stringify(output) ?? '')
        })
      ) {
        throw new Error('Pi tool snapshot could not be retained')
      }
      if (
        [...this.tools.values()].reduce(
          (bytes, tool) => bytes + Buffer.byteLength(JSON.stringify(tool)),
          0
        ) >
        1024 * 1024
      ) {
        throw new Error('Pi tool stream byte capacity exceeded')
      }
    } else {
      this.tools.delete(event.toolCallId)
      this.whole.delete(event.toolCallId)
    }
    return [
      {
        type: state === 'running' ? (previous ? 'item.update' : 'item.open') : 'item.close',
        item: `tool:${event.toolCallId}`,
        body
      }
    ]
  }

  private close(
    item: string,
    channel: 'assistant' | 'reasoning',
    text: string | undefined
  ): ProviderTimelineEvent[] {
    const events: ProviderTimelineEvent[] = []
    // A snapshot without deltas still opens the same message row.
    if (!this.text.has(item) && text) {
      events.push({ type: 'text.delta', item: { id: item }, channel, text })
    }
    events.push({ type: 'text.close', item: { id: item }, text })
    this.text.delete(item)
    return events
  }

  private key(index: number, channel: string): string {
    return `message:${this.generation}:${this.active}:${index}:${channel}`
  }
}
