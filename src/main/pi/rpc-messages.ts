import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../shared/agent-session-journal-types'
import {
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { piRpcMessageEventSchema, piRpcToolEventSchema } from './rpc-protocol'
import type { PiRpcContextUsage } from './rpc-context-usage'

const resultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }))
})

/** Pi does not name assistant messages; ordinals are local to this exact child. */
export class PiRpcMessages {
  private ordinal = 0
  private active?: number
  private readonly text = new Map<string, { index: number; channel: 'assistant' | 'reasoning' }>()
  private readonly tools = new Map<string, AgentJournalToolCallItem>()

  constructor(
    private readonly generation: string,
    private readonly context: PiRpcContextUsage
  ) {}

  reset(): void {
    this.active = undefined
    this.text.clear()
    this.tools.clear()
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
      return []
    }
    const events = this.context.live(event.usage ?? message?.usage, at)
    this.active ??= ++this.ordinal
    const update = event.assistantMessageEvent
    if (
      event.type === 'message_update' &&
      update?.delta !== undefined &&
      ['text_delta', 'thinking_delta'].includes(update.type)
    ) {
      const channel = update.type === 'text_delta' ? 'assistant' : 'reasoning'
      const index = update.contentIndex ?? 0
      const item = this.key(index, channel)
      if (this.text.size >= 128 && !this.text.has(item)) {
        throw new Error('Pi message stream capacity exceeded')
      }
      this.text.set(item, { index, channel })
      events.push({ type: 'text.delta', item: { id: item }, channel, text: update.delta })
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
        const text = channel === 'assistant' ? block.text : block.thinking
        if (text !== undefined) {
          // A snapshot without deltas still opens the same message row.
          if (!this.text.has(item) && text) {
            events.push({ type: 'text.delta', item: { id: item }, channel, text })
          }
          events.push({ type: 'text.close', item: { id: item }, text })
          this.text.delete(item)
        }
      })
      for (const item of this.text.keys()) {
        events.push({ type: 'text.close', item: { id: item } })
      }
      this.text.clear()
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
    const result = event.result ?? event.partialResult
    const content = resultSchema.safeParse(result)
    const output =
      result === undefined
        ? undefined
        : content.success
          ? content.data.content
              .flatMap((block) => (block.text === undefined ? [] : [block.text]))
              .join('\n')
          : JSON.stringify(result)
    const state =
      event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'running'
    const body: AgentJournalToolCallItem = {
      kind: 'tool-call',
      name: event.toolName,
      callId: event.toolCallId,
      input:
        event.args === undefined
          ? (previous?.input ?? null)
          : boundToolInput(event.args, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      state,
      ...(output === undefined
        ? previous?.output
          ? { output: previous.output }
          : {}
        : {
            output: boundPayload(output, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
          })
    }
    if (state === 'running') {
      if (this.tools.size >= 128 && !previous) {
        throw new Error('Pi tool stream capacity exceeded')
      }
      this.tools.set(event.toolCallId, body)
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
    }
    return [
      {
        type: state === 'running' ? (previous ? 'item.update' : 'item.open') : 'item.close',
        item: `tool:${event.toolCallId}`,
        body
      }
    ]
  }

  private key(index: number, channel: string): string {
    return `message:${this.generation}:${this.active}:${index}:${channel}`
  }
}
