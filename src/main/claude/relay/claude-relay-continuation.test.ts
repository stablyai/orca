import { describe, expect, it } from 'vitest'
import {
  RelayedProviderContinuation,
  attachContinuation
} from '../../provider-relay/relayed-provider-continuation'
import { EMPTY_RELAY_ATTACH } from '../../provider-relay/fake-provider-relay-channel.test-fixture'
import {
  CLAUDE_RELAY_CONTINUATION_KEY,
  createClaudeStreamedBlockRegistry
} from '../structured/journal/claude-streamed-block-identity'
import { CLAUDE_RELAY_ITEM_CONTINUATION } from './claude-relay-continuation'
import { createClaudeStreamedTextCheckpoints } from '../structured/journal/claude-streamed-text-checkpoints'

const scope = { session_id: 's', parent_tool_use_id: null }
const delta = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ...scope,
    uuid
  })

describe('a Claude reply a cut replay starts inside', () => {
  it('streams under a stable continuation row, and its final lands on the saved row', () => {
    // Seq 1..4 were dropped at the daemon's cap: message_start of msg_1 is gone.
    const continuation = new RelayedProviderContinuation(CLAUDE_RELAY_ITEM_CONTINUATION, 'r1', 4, 6)
    const blocks = createClaudeStreamedBlockRegistry()
    const replayed = [delta('u5', 'lo'), delta('u6', ' world')].flatMap((line, at) =>
      continuation.lines(5 + at, line, undefined)
    )
    const streamed = replayed.map((line) => blocks.observe(JSON.parse(line), 0))
    expect(streamed.map((each) => each?.identity)).toEqual([
      { provider: 'claude', sessionId: 's', uuid: 'block:relay:r1:s|:0' },
      { provider: 'claude', sessionId: 's', uuid: 'block:relay:r1:s|:0' }
    ])
    const final = blocks.reconcile({ sessionId: 's', parentToolUseId: null, messageId: 'msg_1' })
    expect(final?.identity).toEqual({ provider: 'claude', sessionId: 's', uuid: 'block:msg_1:0' })
    expect(final?.retired).toEqual({
      provider: 'claude',
      sessionId: 's',
      uuid: 'block:relay:r1:s|:0'
    })
  })
})

describe('a Claude reply cut at two reattaches', () => {
  it('continues on one row both times, which its final retires', () => {
    const blocks = createClaudeStreamedBlockRegistry()
    const first = new RelayedProviderContinuation(CLAUDE_RELAY_ITEM_CONTINUATION, 'r1', 4, 6)
    const second = new RelayedProviderContinuation(CLAUDE_RELAY_ITEM_CONTINUATION, 'r1', 40, 41)
    const rows = [
      first.lines(5, delta('u5', 'a'), undefined),
      second.lines(41, delta('u41', 'b'), undefined)
    ]
      .flat()
      .map((line) => blocks.observe(JSON.parse(line), 0)?.identity)
    const row = { provider: 'claude', sessionId: 's', uuid: 'block:relay:r1:s|:0' }
    expect(rows).toEqual([row, row])
    const final = blocks.reconcile({ sessionId: 's', parentToolUseId: null, messageId: 'msg_1' })
    expect(final?.retired).toEqual(row)
  })
})

describe("a background subagent's reply streaming past its turn's result", () => {
  it('re-keys after an attach with only the task open, until the task ends', () => {
    const child = (uuid: string): string =>
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        session_id: 's',
        parent_tool_use_id: 'call_1',
        uuid
      })
    const continuation = attachContinuation(CLAUDE_RELAY_ITEM_CONTINUATION, 'r1', 8, {
      ...EMPTY_RELAY_ATTACH,
      replayThroughSeq: 9,
      openWork: { turn: [], task: [['t1']] }
    })
    expect(continuation).not.toBeNull()
    const [tagged] = continuation!.lines(9, child('u9'), undefined)
    expect(JSON.parse(tagged)).toHaveProperty(CLAUDE_RELAY_CONTINUATION_KEY, 'relay:r1:s|call_1')
    continuation!.lines(
      10,
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 't1',
        session_id: 's'
      }),
      undefined
    )
    expect(continuation!.done).toBe(true)
  })
})

describe("a continuation's final whose block streamed nothing after the cut", () => {
  it('moves onto the saved row its block stop names', () => {
    const blocks = createClaudeStreamedBlockRegistry()
    const placed: unknown[] = []
    const frame = { sessionId: 's', parentToolUseId: null, messageId: 'msg_1' }
    expect(blocks.reconcile(frame)).toBeNull()
    blocks.holdUnplaced(frame, (row) => placed.push(row))
    const stop = (index: number) => ({
      type: 'stream_event',
      event: { type: 'content_block_stop', index },
      ...scope,
      uuid: `stop${index}`
    })
    expect(blocks.placeAt(stop(1))).toBe(true)
    expect(blocks.placeAt(stop(2))).toBe(false)
    expect(placed).toEqual([{ provider: 'claude', sessionId: 's', uuid: 'block:msg_1:1' }])
  })
})

describe('a continuation row whose reply ends without its final', () => {
  it('moves its text to a row of its own and frees the shared row', () => {
    const writes: unknown[] = []
    const retired: unknown[] = []
    const never = (): never => {
      throw new Error('root rows read no linkage')
    }
    const text = createClaudeStreamedTextCheckpoints({
      persist: (identity, body) => writes.push([identity, body]),
      retire: (identity) => retired.push(identity),
      producer: { linkageFor: never, settledLinkageFor: never },
      schedule: () => () => {}
    })
    const shared = { provider: 'claude' as const, sessionId: 's', uuid: 'block:relay:r1:s|:0' }
    text.append(shared, 'interrupted suffix')
    text.finish({ completedAt: 7 })
    expect(writes.at(-1)).toEqual([
      { ...shared, uuid: 'block:relay:r1:s|:0:ended:7' },
      'interrupted suffix'
    ])
    expect(retired).toEqual([shared])
  })
})
