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
  outstanding: ProviderRelayAttachResult['outstanding']
): ProviderRelayAttachResult => ({
  replayThroughSeq: 16,
  pending: [],
  maxClientRequestId: 7,
  initializeResultSent: true,
  stderrTail: '',
  exit: null,
  ...(outstanding ? { outstanding } : {})
})

describe('ACP relay item continuation', () => {
  it('moves only the message a cap-released cursor starts inside, the same way on every attach, until the prompt is answered', () => {
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
      // The cursor (10) is past the prompt's start: no daemon cut, but its turn isn't replayed whole.
      const cut = attachContinuation(hook, 'r1', 10, attach([{ id: 7, method: 'session/prompt' }]))
      return replay.map((line, at) => {
        const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
        return out.includes('session/update') ? idOf(out) : 'answer'
      })
    }
    const first = run()
    expect(first).toEqual(['relay:r1:11:m1', 'relay:r1:11:m1', undefined, 'm2', 'answer', 'm3'])
    expect(run()).toEqual(first)
    const whole = [{ id: 7, method: 'session/prompt', replayedWhole: true as const }]
    expect(attachContinuation(hook, 'r1', 10, attach(whole))).toBeNull()
  })
})
