import { z } from 'zod'
import type {
  AgentJournalDiffItem,
  AgentJournalToolCallItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  boundToolInput,
  JOURNAL_RUNNING_PREVIEW_LIMITS,
  journalPayload,
  journalToolPayload
} from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { replacementPatch } from '../../native-chat/agent-session-timeline/provider-timeline-replacement-patch'
import { piRpcMessageEventSchema, piRpcToolEventSchema } from './rpc-protocol'
import type { PiRpcContextUsage } from './rpc-context-usage'

const resultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }))
})
const fileInputSchema = z.object({ path: z.string().min(1), content: z.string().optional() })
const editResultSchema = z.object({ details: z.object({ patch: z.string().min(1) }) })

/** Prefixing every line costs per line as well as per char, so a larger write keeps the tool row instead of stalling this process. */
const MAX_WRITE_DIFF_CHARS = 64 * 1024
const MAX_WRITE_DIFF_LINE_BREAKS = 16 * 1024

function fitsWriteDiff(content: string): boolean {
  if (content.length > MAX_WRITE_DIFF_CHARS) {
    return false
  }
  let lineBreaks = 0
  for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1)) {
    lineBreaks += 1
    if (lineBreaks > MAX_WRITE_DIFF_LINE_BREAKS) {
      return false
    }
  }
  return true
}

/** Pi's edit result carries a unified patch and a write carries the whole file, so both close as diffs like Codex file changes. */
function fileChange(tool: string, input: unknown, result: unknown): AgentJournalDiffItem | null {
  if (tool !== 'edit' && tool !== 'write') {
    return null
  }
  const file = fileInputSchema.safeParse(input).data
  const patch =
    tool === 'edit'
      ? editResultSchema.safeParse(result).data?.details.patch
      : file?.content !== undefined && fitsWriteDiff(file.content)
        ? replacementPatch(file.path, '', file.content)
        : undefined
  return file && patch !== undefined
    ? { kind: 'diff', path: file.path, patch: journalPayload(patch) }
    : null
}

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
  private readonly whole = new Map<string, { input?: unknown; output?: string }>()

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
      this.tools.set(event.toolCallId, body)
      this.whole.set(event.toolCallId, { input, output })
    } else {
      this.tools.delete(event.toolCallId)
      this.whole.delete(event.toolCallId)
    }
    return [
      {
        type: state === 'running' ? (previous ? 'item.update' : 'item.open') : 'item.close',
        item: `tool:${event.toolCallId}`,
        body: (state === 'completed' && fileChange(event.toolName, input, result)) || body
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
