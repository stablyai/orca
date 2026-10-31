import { z } from 'zod'
import { PiRpcMessages } from '../pi/rpc-messages'
import { PiRpcContextUsage } from '../pi/rpc-context-usage'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { MAX_PROVIDER_TIMELINE_OPEN_BYTES } from '../native-chat/agent-session-timeline/provider-timeline-budget'
import { ompEditResultEvents } from './rpc-edit-results'
import { ompTodoEvents } from './rpc-todo'

const lifecycleSchema = z.object({
  id: z.string(),
  status: z.string(),
  parentToolCallId: z.string().optional()
})
const eventSchema = z.object({ id: z.string(), event: z.looseObject({ type: z.string() }) })
const toolSchema = z.object({ toolCallId: z.string(), toolName: z.string() })

type Run = { key: string; messages: PiRpcMessages; parent?: string; tools: Map<string, string> }

export class OmpRpcSubagentMessages {
  private readonly runs = new Map<string, Run>()
  private ordinal = 0

  constructor(private readonly generation: string) {}

  receive(frame: JsonlRpcRecord): ProviderTimelineEvent[] {
    if (frame.type === 'subagent_lifecycle') {
      const child = lifecycleSchema.parse(frame.payload)
      let run = this.runs.get(child.id)
      if (child.status === 'started') {
        if (!run) {
          if (this.runs.size >= 128) {
            throw new Error('OMP subagent transcript capacity exceeded')
          }
          const key = JSON.stringify([this.generation, child.id, ++this.ordinal])
          run = {
            key,
            parent: child.parentToolCallId,
            tools: new Map(),
            messages: new PiRpcMessages(key, new PiRpcContextUsage())
          }
          this.runs.set(child.id, run)
        }
        return []
      }
      if (!run) {
        return []
      }
      const events = run.messages.message(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [] }
        },
        Date.now()
      )
      for (const [toolCallId, toolName] of run.tools) {
        events.push(
          ...run.messages.tool({
            type: 'tool_execution_end',
            toolCallId,
            toolName,
            isError: true,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Subagent ended (${child.status}) before this tool returned.`
                }
              ]
            }
          })
        )
      }
      this.runs.delete(child.id)
      return this.attribute(child.id, run, events)
    }
    if (frame.type !== 'subagent_event') {
      return []
    }
    const payload = eventSchema.parse(frame.payload)
    const run = this.runs.get(payload.id)
    if (!run) {
      return []
    }
    const event = payload.event
    let events: ProviderTimelineEvent[] = []
    if (['message_start', 'message_update', 'message_end'].includes(event.type)) {
      events = run.messages.message(event, Date.now())
    } else if (
      ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)
    ) {
      const tool = toolSchema.parse(event)
      if (event.type === 'tool_execution_end') {
        run.tools.delete(tool.toolCallId)
      } else {
        run.tools.set(tool.toolCallId, tool.toolName)
      }
      events = run.messages.tool(event)
      events.push(...ompEditResultEvents(event))
      events.push(...ompTodoEvents(event))
    }
    if (
      [...this.runs.values()].reduce((bytes, each) => bytes + each.messages.retainedToolBytes, 0) >
      MAX_PROVIDER_TIMELINE_OPEN_BYTES
    ) {
      throw new Error('OMP subagent transcript byte capacity exceeded')
    }
    return this.attribute(payload.id, run, events)
  }

  private attribute(
    id: string,
    run: Run,
    events: ProviderTimelineEvent[]
  ): ProviderTimelineEvent[] {
    return events.flatMap((event): ProviderTimelineEvent[] => {
      const join = { thread: run.key }
      const producer = {
        agentId: id,
        producerKind: 'agent' as const,
        ...(run.parent ? { providerParentRef: run.parent } : {})
      }
      switch (event.type) {
        case 'item.open':
        case 'item.update':
        case 'item.close':
        case 'text.delta':
          return [{ ...event, join, producer }]
        case 'text.close':
          return [{ ...event, join }]
        default:
          // Child accounting and lifecycle never change the root turn.
          return []
      }
    })
  }
}
