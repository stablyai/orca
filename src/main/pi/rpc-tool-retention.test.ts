import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalToolCallItem } from '../../shared/agent-session-journal-types'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { PiRpcContextUsage } from './rpc-context-usage'
import { PiRpcMessages } from './rpc-messages'

afterEach(() => vi.restoreAllMocks())

function messages(): PiRpcMessages {
  return new PiRpcMessages('generation', new PiRpcContextUsage())
}

function toolBody(events: ProviderTimelineEvent[]): AgentJournalToolCallItem {
  const event = events[0]
  if (
    !event ||
    !['item.open', 'item.update', 'item.close'].includes(event.type) ||
    !('body' in event) ||
    event.body.kind !== 'tool-call'
  ) {
    throw new Error('Expected a tool event')
  }
  return event.body
}

function start(tools: PiRpcMessages, id: string, name = 'bash'): AgentJournalToolCallItem {
  return toolBody(
    tools.tool({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: null })
  )
}

describe('Pi running tool retention', () => {
  it('serializes only the updated retained body', () => {
    const tools = messages()
    for (let index = 0; index < 64; index++) {
      start(tools, `tool-${index}`)
    }
    const stringify = vi.spyOn(JSON, 'stringify')
    for (let index = 0; index < 20; index++) {
      tools.tool({ type: 'tool_execution_update', toolCallId: 'tool-0', toolName: 'bash' })
    }
    expect(stringify).toHaveBeenCalledTimes(20)
  })

  it('preserves inherited input, bounded output and close states', () => {
    const tools = messages()
    const initial = toolBody(
      tools.tool({
        type: 'tool_execution_start',
        toolCallId: 'one',
        toolName: 'bash',
        args: { command: 'echo 🐋' },
        partialResult: { content: [{ type: 'text', text: '🐋'.repeat(6000) }] }
      })
    )
    expect(initial.output?.truncated).toBe(true)
    const update = tools.tool({
      type: 'tool_execution_update',
      toolCallId: 'one',
      toolName: 'bash'
    })
    expect(update[0]?.type).toBe('item.update')
    expect(toolBody(update)).toEqual(initial)
    const completed = toolBody(
      tools.tool({ type: 'tool_execution_end', toolCallId: 'one', toolName: 'bash' })
    )
    expect(completed).toEqual({ ...initial, state: 'completed' })
    expect(
      toolBody(
        tools.tool({
          type: 'tool_execution_end',
          toolCallId: 'unknown',
          toolName: 'bash',
          isError: true,
          result: { exitCode: 1 }
        })
      )
    ).toMatchObject({ state: 'failed', input: null, output: { head: '{"exitCode":1}' } })
  })

  it('keeps the 128-tool ceiling across replacements, closes and reset', () => {
    const tools = messages()
    for (let index = 0; index < 128; index++) {
      start(tools, `tool-${index}`)
    }
    expect(() => start(tools, 'tool-0')).not.toThrow()
    expect(() => start(tools, 'extra')).toThrow('Pi tool stream capacity exceeded')
    tools.tool({ type: 'tool_execution_end', toolCallId: 'unknown', toolName: 'bash' })
    expect(() => start(tools, 'extra')).toThrow('Pi tool stream capacity exceeded')
    tools.tool({ type: 'tool_execution_end', toolCallId: 'tool-0', toolName: 'bash' })
    expect(() => start(tools, 'extra')).not.toThrow()
    tools.reset()
    expect(
      tools.tool({ type: 'tool_execution_update', toolCallId: 'extra', toolName: 'bash' })[0]
    ).toMatchObject({ type: 'item.open', body: { input: null } })
  })

  it('keeps the exact UTF-8 byte ceiling and retained state after a failed update', () => {
    const tools = messages()
    const first = start(tools, 'first', '🐋'.repeat(4000))
    const bytes = Buffer.byteLength(JSON.stringify(first))
    const empty = start(tools, 'last', '')
    const padding = 1024 * 1024 - bytes - Buffer.byteLength(JSON.stringify(empty))
    const atLimit = 'a'.repeat(padding)
    expect(() => start(tools, 'last', atLimit)).not.toThrow()
    expect(() => start(tools, 'last', `${atLimit}a`)).toThrow(
      'Pi tool stream byte capacity exceeded'
    )
    // The rejected replacement remains retained, as before, until it is shrunk or closed.
    expect(() => start(tools, 'first', first.name)).toThrow('Pi tool stream byte capacity exceeded')
    expect(() => start(tools, 'last', atLimit)).not.toThrow()
    tools.tool({ type: 'tool_execution_end', toolCallId: 'unknown', toolName: 'bash' })
    expect(() => start(tools, 'last', `${atLimit}a`)).toThrow(
      'Pi tool stream byte capacity exceeded'
    )
    tools.tool({ type: 'tool_execution_end', toolCallId: 'last', toolName: 'bash' })
    expect(() => start(tools, 'last', atLimit)).not.toThrow()
    tools.reset()
    expect(() => start(tools, 'last', atLimit)).not.toThrow()
    expect(() => start(tools, 'first', first.name)).not.toThrow()
  })
})
