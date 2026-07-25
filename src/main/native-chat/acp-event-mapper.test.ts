import { describe, expect, it } from 'vitest'
import { createAcpTurnAccumulator } from './acp-event-mapper'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  isTextBlock,
  isToolCallBlock,
  isToolResultBlock
} from '../../shared/native-chat-types'

const AT = 1_700_000_000_000

describe('createAcpTurnAccumulator', () => {
  it('coalesces streamed assistant chunks into one stable message', () => {
    const acc = createAcpTurnAccumulator('s1')
    const first = acc.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
      AT
    )
    const second = acc.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
      AT
    )

    expect(first.messages).toHaveLength(1)
    expect(second.messages).toHaveLength(1)
    // Same id on both emissions is what lets the merger replace rather than append.
    expect(second.messages[0].id).toBe(first.messages[0].id)
    expect(second.messages[0].role).toBe('assistant')
    expect(second.messages[0].source).toBe('acp')
    const block = second.messages[0].blocks[0]
    expect(isTextBlock(block) && block.text).toBe('Hello')
  })

  it('ranks acp above the file transcript so live updates win dedup', () => {
    expect(NATIVE_CHAT_SOURCE_PRIORITY.acp).toBeGreaterThan(NATIVE_CHAT_SOURCE_PRIORITY.transcript)
  })

  it('maps thought chunks to the reasoning role, separate from the reply', () => {
    const acc = createAcpTurnAccumulator('s1')
    const thought = acc.decode(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      AT
    )
    const reply = acc.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      AT
    )

    expect(thought.messages[0].role).toBe('reasoning')
    expect(reply.messages[0].role).toBe('assistant')
    // Distinct ids: reasoning must not overwrite the reply in the merger.
    expect(thought.messages[0].id).not.toBe(reply.messages[0].id)
  })

  it('starts a new turn when the user speaks after an assistant reply', () => {
    const acc = createAcpTurnAccumulator('s1')
    acc.decode({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }, AT)
    const user = acc.decode(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'next' } },
      AT
    )
    const reply = acc.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } },
      AT
    )

    // The second reply is a fresh message, not 'a' + 'b' concatenated.
    const block = reply.messages[0].blocks[0]
    expect(isTextBlock(block) && block.text).toBe('b')
    expect(user.messages[0].turnId).toBe(reply.messages[0].turnId)
  })

  it('emits a tool call, then re-emits it with its result on completion', () => {
    const acc = createAcpTurnAccumulator('s1')
    const call = acc.decode(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read_file',
        rawInput: { path: '/tmp/x' }
      },
      AT
    )
    const done = acc.decode(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [{ content: { type: 'text', text: 'file body' } }]
      },
      AT
    )

    expect(call.messages[0].role).toBe('tool')
    const callBlock = call.messages[0].blocks[0]
    expect(isToolCallBlock(callBlock) && callBlock.name).toBe('read_file')

    // Same id so the completed call replaces the pending one in place.
    expect(done.messages[0].id).toBe(call.messages[0].id)
    expect(done.messages[0].blocks).toHaveLength(2)
    const resultBlock = done.messages[0].blocks[1]
    expect(isToolResultBlock(resultBlock) && resultBlock.output).toBe('file body')
    expect(isToolResultBlock(resultBlock) && resultBlock.isError).toBe(false)
  })

  it('flags a failed tool call as an error result', () => {
    const acc = createAcpTurnAccumulator('s1')
    acc.decode({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'bash' }, AT)
    const failed = acc.decode(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        status: 'failed',
        content: [{ content: { type: 'text', text: 'boom' } }]
      },
      AT
    )
    const block = failed.messages[0].blocks[1]
    expect(isToolResultBlock(block) && block.isError).toBe(true)
  })

  it('ignores in-progress tool updates so the call block does not thrash', () => {
    const acc = createAcpTurnAccumulator('s1')
    acc.decode({ sessionUpdate: 'tool_call', toolCallId: 'tc-3', title: 'bash' }, AT)
    expect(
      acc.decode({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'in_progress' }, AT)
        .messages
    ).toHaveLength(0)
  })

  it('skips unknown and contentless update variants instead of throwing', () => {
    const acc = createAcpTurnAccumulator('s1')
    expect(acc.decode({ sessionUpdate: 'current_mode_update', modeId: 'ask' }, AT).messages).toEqual(
      []
    )
    expect(acc.decode({ sessionUpdate: 'plan', entries: [] }, AT).messages).toEqual([])
    expect(acc.decode({ sessionUpdate: 'some_future_variant' }, AT).messages).toEqual([])
    expect(acc.decode({}, AT).messages).toEqual([])
  })

  it('renders an image chunk as an image reference', () => {
    const acc = createAcpTurnAccumulator('s1')
    const shot = acc.decode(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      },
      AT
    )
    expect(shot.messages[0].blocks[0]).toEqual({
      type: 'image-ref',
      url: 'data:image/png;base64,AAAA'
    })
  })

  it('reports turn completion as lifecycle evidence and resets streaming', () => {
    const acc = createAcpTurnAccumulator('s1')
    acc.decode({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }, AT)
    const ended = acc.endTurn('completed', AT)
    expect(ended.lifecycle).toEqual({ state: 'completed', turnId: 'acp-s1-0', timestamp: AT })

    // After the turn closes, the next chunk starts a fresh message.
    const next = acc.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y' } },
      AT
    )
    const block = next.messages[0].blocks[0]
    expect(isTextBlock(block) && block.text).toBe('y')
  })

  it('reports interruption so the view can show the interrupted status', () => {
    const acc = createAcpTurnAccumulator('s1')
    acc.decode({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }, AT)
    expect(acc.endTurn('interrupted', AT).lifecycle?.state).toBe('interrupted')
  })

  it('scopes message ids by session so two open chats never collide', () => {
    const a = createAcpTurnAccumulator('session-a')
    const b = createAcpTurnAccumulator('session-b')
    const first = a.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      AT
    )
    const second = b.decode(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      AT
    )
    expect(first.messages[0].id).not.toBe(second.messages[0].id)
  })
})
