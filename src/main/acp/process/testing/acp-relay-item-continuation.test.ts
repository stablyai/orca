import { describe, expect, it } from 'vitest'
import type { ProviderRelayAttachResult } from '../../../daemon/protocol/daemon-provider-relay-protocol'
import { attachContinuation } from '../../../provider-relay/relayed-provider-continuation'
import { AcpRelayItemContinuation } from '../acp-relay-item-continuation'

const update = (fields: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: fields }
  })
const chunk = (messageId: string, text: string) =>
  update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
const idOf = (line: string): unknown => JSON.parse(line).params.update.messageId

const attach = (
  outstanding: ProviderRelayAttachResult['outstanding'],
  truncatedThrough?: number
): ProviderRelayAttachResult => ({
  replayThroughSeq: 16,
  pending: [],
  maxClientRequestId: 7,
  initializeResultSent: true,
  stderrTail: '',
  exit: null,
  ...(outstanding ? { outstanding } : {}),
  ...(truncatedThrough === undefined ? {} : { truncatedThrough })
})

describe('ACP relay item continuation', () => {
  it('moves only the message a cut replay starts inside, the same way on every attach, until the prompt is answered', () => {
    const hook = new AcpRelayItemContinuation()
    const replay = [
      chunk('m1', 'tail'),
      chunk('m1', 'more'),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c1' }),
      chunk('m2', 'whole'),
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }),
      chunk('m3', 'next turn')
    ]
    const run = () => {
      hook.reset()
      // The daemon dropped kept lines through 10, past the prompt's start.
      const cut = attachContinuation(
        hook,
        'r1',
        10,
        attach([{ id: 7, method: 'session/prompt' }], 10)
      )
      return replay.map((line, at) => {
        const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
        return out.includes('session/update') ? idOf(out) : 'answer'
      })
    }
    const first = run()
    expect(first).toEqual(['relay:r1:11:m1', 'relay:r1:11:m1', undefined, 'm2', 'answer', 'm3'])
    expect(run()).toEqual(first)
    // A replay the daemon didn't cut starts at each open item's first line: nothing moves.
    expect(
      attachContinuation(hook, 'r1', 10, attach([{ id: 7, method: 'session/prompt' }]))
    ).toBeNull()
  })

  it("moves each session's cut message, whatever another session's lines replay first", () => {
    const hook = new AcpRelayItemContinuation()
    const child = (fields: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'opencode/session/child_update',
        params: { rootSessionId: 's', childSessionId: 'c', type: 'update', update: fields }
      })
    const text = { type: 'text', text: 'x' }
    const replay = [
      child({ sessionUpdate: 'tool_call', toolCallId: 'c1' }),
      chunk('m1', 'root tail'),
      child({ sessionUpdate: 'agent_message_chunk', messageId: 'k2', content: text })
    ]
    const cut = attachContinuation(
      hook,
      'r1',
      10,
      attach([{ id: 7, method: 'session/prompt' }], 10)
    )
    const ids = replay.map((line, at) => {
      const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
      return JSON.parse(out).params.update.messageId
    })
    // The child's boundary came first, so its next message starts whole; the root's tail moves.
    expect(ids).toEqual([undefined, 'relay:r1:12:m1', 'k2'])
  })
})
