import { describe, expect, it } from 'vitest'
import { RelayedProviderContinuation } from '../../../provider-relay/relayed-provider-continuation'
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

describe('ACP relay item continuation', () => {
  it('moves only the message a cut replay starts inside, the same way on every attach', () => {
    const hook = new AcpRelayItemContinuation()
    const replay = [
      chunk('m1', 'tail'),
      chunk('m1', 'more'),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c1' }),
      chunk('m2', 'whole')
    ]
    const run = () => {
      hook.reset()
      const cut = new RelayedProviderContinuation(hook, 'r1', 10)
      return replay.map((line, at) => idOf(cut.lines(11 + at, line, undefined)[0] ?? ''))
    }
    const first = run()
    expect(first).toEqual(['relay:r1:11:m1', 'relay:r1:11:m1', undefined, 'm2'])
    expect(run()).toEqual(first)
  })
})
