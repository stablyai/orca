import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  foldToolMessages,
  pairToolBlocks,
  splitNativeChatBlocks
} from './mobile-native-chat-blocks'

function msg(
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks'],
  id: string = role
): NativeChatMessage {
  return { id, role, blocks, timestamp: 0, source: 'transcript' }
}

describe('splitNativeChatBlocks', () => {
  it('separates prose from tool blocks', () => {
    const { prose, tools } = splitNativeChatBlocks([
      { type: 'text', text: 'hi' },
      { type: 'tool-call', name: 'Bash', input: {} },
      { type: 'tool-result', output: 'ok' }
    ])
    expect(prose.map((b) => b.type)).toEqual(['text'])
    expect(tools.map((b) => b.type)).toEqual(['tool-call', 'tool-result'])
  })
})

describe('pairToolBlocks', () => {
  it('pairs each call with the following result', () => {
    const pairs = pairToolBlocks([
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', output: 'a\nb' },
      { type: 'tool-call', name: 'Edit', input: {} },
      { type: 'tool-result', output: 'ok' }
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0]!.call?.name).toBe('Bash')
    expect(pairs[0]!.result?.output).toBe('a\nb')
    expect(pairs[1]!.call?.name).toBe('Edit')
  })

  it('keeps an orphan result on its own', () => {
    const pairs = pairToolBlocks([{ type: 'tool-result', output: 'x' }])
    expect(pairs).toEqual([{ result: { type: 'tool-result', output: 'x' } }])
  })

  it('does not attach a second result to an already-filled pair', () => {
    const pairs = pairToolBlocks([
      { type: 'tool-call', name: 'Bash', input: {} },
      { type: 'tool-result', output: '1' },
      { type: 'tool-result', output: '2' }
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[1]!.call).toBeUndefined()
    expect(pairs[1]!.result?.output).toBe('2')
  })

  it('pairs batched parallel calls by ordinal, not adjacency', () => {
    const call1 = { type: 'tool-call' as const, name: 'Bash', input: { command: 'a' } }
    const call2 = { type: 'tool-call' as const, name: 'Bash', input: { command: 'b' } }
    const result1 = { type: 'tool-result' as const, output: 'out-a' }
    const result2 = { type: 'tool-result' as const, output: 'out-b' }
    // Parallel calls stream as [call, call, result, result]; the Nth result
    // answers the Nth call, so result1 must land on call1 (not the nearer call2).
    const pairs = pairToolBlocks([call1, call2, result1, result2])

    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toEqual({ call: call1, result: result1 })
    expect(pairs[1]).toEqual({ call: call2, result: result2 })
  })

  it('does not graft a dropped over-limit call result onto a kept call', () => {
    const call1 = { type: 'tool-call' as const, name: 'Bash', input: { command: 'a' } }
    const call2 = { type: 'tool-call' as const, name: 'Bash', input: { command: 'b' } }
    const call3 = { type: 'tool-call' as const, name: 'Bash', input: { command: 'c' } }
    const result1 = { type: 'tool-result' as const, output: 'out-a' }
    const result2 = { type: 'tool-result' as const, output: 'out-b' }
    const result3 = { type: 'tool-result' as const, output: 'out-c' }
    const pairs = pairToolBlocks([call1, call2, call3, result1, result2, result3], 2)

    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toEqual({ call: call1, result: result1 })
    // call3 was dropped past the limit, so result3 must not misgraft onto call2.
    expect(pairs[1]).toEqual({ call: call2, result: result2 })
  })

  it('retains the last result while bounding rendered pairs', () => {
    const blocks = Array.from({ length: 20 }, (_unused, index) => [
      { type: 'tool-call' as const, name: 'Bash', input: { index } },
      { type: 'tool-result' as const, output: String(index) }
    ]).flat()
    const pairs = pairToolBlocks(blocks, 6)

    expect(pairs).toHaveLength(6)
    expect(pairs[5].result?.output).toBe('5')
  })
})

describe('foldToolMessages', () => {
  it('folds tool-call-only assistant messages and result messages into the prose turn', () => {
    const folded = foldToolMessages([
      msg('assistant', [{ type: 'text', text: 'doing' }], 'a0'),
      msg('assistant', [{ type: 'tool-call', name: 'Bash', input: {} }], 'a1'),
      msg('tool', [{ type: 'tool-result', output: 'done' }], 't1'),
      msg('assistant', [{ type: 'tool-call', name: 'Edit', input: {} }], 'a2'),
      msg('tool', [{ type: 'tool-result', output: 'ok' }], 't2')
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0]!.blocks.map((b) => b.type)).toEqual([
      'text',
      'tool-call',
      'tool-result',
      'tool-call',
      'tool-result'
    ])
  })

  it('starts a new turn at the next prose assistant message', () => {
    const folded = foldToolMessages([
      msg('assistant', [{ type: 'text', text: 't1' }], 'a0'),
      msg('assistant', [{ type: 'tool-call', name: 'Bash', input: {} }], 'a1'),
      msg('assistant', [{ type: 'text', text: 't2' }], 'a2')
    ])
    expect(folded.map((m) => m.id)).toEqual(['a0', 'a2'])
  })

  it('keeps a tool message standalone when no assistant precedes it', () => {
    const folded = foldToolMessages([msg('tool', [{ type: 'tool-result', output: 'x' }])])
    expect(folded).toHaveLength(1)
    expect(folded[0]!.role).toBe('tool')
  })

  it('does not merge across a user message', () => {
    const folded = foldToolMessages([
      msg('assistant', [{ type: 'tool-call', name: 'Bash', input: {} }], 'a'),
      msg('user', [{ type: 'text', text: 'q' }], 'u'),
      msg('tool', [{ type: 'tool-result', output: 'r' }], 't')
    ])
    expect(folded.map((m) => m.role)).toEqual(['assistant', 'user', 'tool'])
  })

  it('folds a long tool run without mutating the source assistant', () => {
    const assistant = msg('assistant', [{ type: 'text', text: 'working' }], 'a')
    const tools = Array.from({ length: 1_000 }, (_unused, index) =>
      msg('tool', [{ type: 'tool-result', output: String(index) }], `t-${index}`)
    )
    const folded = foldToolMessages([assistant, ...tools])

    expect(folded[0].blocks).toHaveLength(1_001)
    expect(assistant.blocks).toHaveLength(1)
  })
})
