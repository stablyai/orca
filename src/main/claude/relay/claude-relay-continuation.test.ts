import { describe, expect, it } from 'vitest'
import { RelayedProviderContinuation } from '../../provider-relay/relayed-provider-continuation'
import { createClaudeStreamedBlockRegistry } from '../structured/journal/claude-streamed-block-identity'
import { CLAUDE_RELAY_ITEM_CONTINUATION } from './claude-relay-continuation'

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
    const continuation = new RelayedProviderContinuation(CLAUDE_RELAY_ITEM_CONTINUATION, 'r1', 4)
    const blocks = createClaudeStreamedBlockRegistry()
    const replayed = [delta('u5', 'lo'), delta('u6', ' world')].flatMap((line, at) =>
      continuation.lines(5 + at, line, undefined)
    )
    const streamed = replayed.map((line) => blocks.observe(JSON.parse(line), 0))
    expect(streamed.map((each) => each?.identity)).toEqual([
      { provider: 'claude', sessionId: 's', uuid: 'block:relay:r1:5:0' },
      { provider: 'claude', sessionId: 's', uuid: 'block:relay:r1:5:0' }
    ])
    const final = blocks.reconcile({ sessionId: 's', parentToolUseId: null, messageId: 'msg_1' })
    expect(final?.identity).toEqual({ provider: 'claude', sessionId: 's', uuid: 'block:msg_1:0' })
    expect(final?.retired).toEqual({
      provider: 'claude',
      sessionId: 's',
      uuid: 'block:relay:r1:5:0'
    })
  })
})
