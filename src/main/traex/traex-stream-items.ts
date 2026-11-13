import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { createAgentSessionDeltaCoalescer } from '../native-chat/agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import { traexContentText, traexItemSchema, traexText } from './traex-protocol'
import { traexItemBody, traexItemEvents } from './traex-item-translation'

export class TraexStreamItems {
  private readonly textItems = new Set<string>()
  private readonly tools = new Map<
    string,
    { item: ReturnType<typeof traexItemSchema.parse>; turn: string }
  >()
  private readonly toolOutput

  constructor(
    private readonly deps: {
      threadId: string
      includeUserMessages: boolean
      itemKey: (turn: string, id: string) => string
      apply: (event: ProviderTimelineEvent) => void
      failed: () => boolean
    }
  ) {
    this.toolOutput = createAgentSessionDeltaCoalescer({
      emit: (key, text) => {
        const tool = this.tools.get(key)
        if (tool) {
          const body = traexItemBody(
            tool.item.type === 'plan'
              ? { ...tool.item, text }
              : { ...tool.item, aggregatedOutput: text },
            false
          )
          if (body) {
            this.deps.apply({
              type: 'item.update',
              item: key,
              body,
              join: { thread: deps.threadId, turn: tool.turn }
            })
          }
        }
        return !deps.failed()
      }
    })
  }

  notification(method: string, params: Record<string, unknown>, turn: string): boolean {
    const threadId = this.deps.threadId
    const join = { thread: threadId, turn }
    if (method === 'item/fileChange/patchUpdated') {
      const id = traexText(params.itemId)
      if (id && Array.isArray(params.changes)) {
        const key = this.deps.itemKey(turn, id),
          item = { ...this.tools.get(key)?.item, id, type: 'fileChange', changes: params.changes }
        this.tools.set(key, { item, turn })
        const body = traexItemBody(item, false)
        if (body) {
          this.deps.apply({ type: 'item.update', item: key, body, join })
        }
      }
      return true
    }
    if (method === 'item/commandExecution/terminalInteraction') {
      const id = traexText(params.toolCallId) ?? traexText(params.itemId)
      if (id) {
        const body = traexItemBody({ ...params, id, type: 'terminalInteraction' }, true)
        if (body) {
          this.deps.apply({ type: 'item.close', item: this.deps.itemKey(turn, id), body, join })
        }
      }
      return true
    }
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      const nativeId = traexText(params.itemId)
      const id = nativeId ? this.deps.itemKey(turn, nativeId) : undefined
      const text = traexText(params.delta)
      if (id && text !== undefined) {
        this.textItems.add(id)
        this.deps.apply({
          type: 'text.delta',
          item: { id },
          text,
          channel: method === 'item/agentMessage/delta' ? 'assistant' : 'reasoning',
          join
        })
      }
      return true
    }
    if (
      method === 'item/commandExecution/outputDelta' ||
      method === 'item/fileChange/outputDelta' ||
      method === 'item/plan/delta'
    ) {
      const nativeId = traexText(params.itemId)
      const id = nativeId ? this.deps.itemKey(turn, nativeId) : undefined
      if (id && typeof params.delta === 'string') {
        if (!this.tools.has(id)) {
          this.tools.set(id, {
            item: {
              id: nativeId!,
              type:
                method === 'item/commandExecution/outputDelta'
                  ? 'commandExecution'
                  : method === 'item/plan/delta'
                    ? 'plan'
                    : 'fileChange'
            },
            turn
          })
        }
        this.toolOutput.append(id, params.delta)
      }
      return true
    }
    this.toolOutput.flushAll()
    if (method === 'item/mcpToolCall/progress') {
      const id = traexText(params.itemId),
        message = traexText(params.message)
      if (id && message) {
        const key = this.deps.itemKey(turn, id),
          tool = this.tools.get(key)
        if (tool) {
          const body = traexItemBody({ ...tool.item, aggregatedOutput: message }, false)
          if (body) {
            this.deps.apply({ type: 'item.update', item: key, body, join })
          }
        }
      }
      return true
    }
    if (method === 'item/started' || method === 'item/completed') {
      const parsed = traexItemSchema.safeParse(params.item)
      if (
        !parsed.success ||
        (parsed.data.type === 'userMessage' && !this.deps.includeUserMessages)
      ) {
        return true
      }
      const item = parsed.data
      const key = this.deps.itemKey(
        turn,
        item.type === 'contextCompaction' ? 'contextCompaction' : item.id
      )
      const completed = method === 'item/completed'
      if (!completed && ['agentMessage', 'reasoning'].includes(item.type)) {
        return true
      }
      if (completed && this.textItems.delete(key)) {
        const text =
          item.type === 'reasoning'
            ? traexContentText(item.text) ||
              traexContentText(item.summary) ||
              traexContentText(item.content)
            : traexText(item.text)
        const body = traexItemBody(item, true)
        if (body?.kind === 'message' && body.blocks.some((block) => block.type !== 'text')) {
          this.deps.apply({ type: 'item.close', item: key, body, join })
        } else {
          this.deps.apply({
            type: 'text.close',
            item: { id: key },
            ...(text ? { text } : {}),
            join
          })
        }
      } else {
        const output = this.toolOutput.snapshot(key)
        for (const event of traexItemEvents(
          output && item.aggregatedOutput == null
            ? { ...item, aggregatedOutput: output.text }
            : item,
          threadId,
          turn,
          completed,
          key
        )) {
          this.deps.apply(
            item.type === 'contextCompaction' && 'join' in event
              ? { ...event, join: { thread: threadId, scope: { kind: 'thread' } } }
              : event
          )
        }
      }
      if (completed) {
        this.tools.delete(key)
        this.toolOutput.forget(key)
      } else if (!['agentMessage', 'reasoning'].includes(item.type)) {
        this.tools.set(key, { item, turn })
      }
      return true
    }
    return false
  }

  flush(): void {
    this.toolOutput.flushAll()
  }

  dispose(): void {
    this.toolOutput.dispose()
    this.tools.clear()
    this.textItems.clear()
  }
}
