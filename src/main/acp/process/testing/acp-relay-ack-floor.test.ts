import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RelayedProviderOutput } from '../../../provider-relay/relayed-provider-output'
import { createAcpRelayAckFloor } from '../acp-relay-ack-floor'

const update = (sessionUpdate: string, rest: Record<string, unknown> = {}): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate, ...rest } }
  })
const chunk = (text: string, messageId?: string): string =>
  update('agent_message_chunk', {
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {})
  })
const answer = (id: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })

function rig() {
  const acks: number[] = []
  const output = new RelayedProviderOutput({
    stdout: new Readable({ read() {} }),
    ackFloor: createAcpRelayAckFloor(),
    durable: async () => true,
    ack: async (seq) => {
      acks.push(seq)
    }
  })
  output.restartAt(0)
  let seq = 0
  const send = async (...lines: string[]): Promise<number[]> => {
    lines.forEach((line) => output.line('relayData', ++seq, line))
    await output.settle()
    return acks
  }
  return { output, acks, send }
}

describe('ACP relay ack floor', () => {
  it('acks only below the start of an open call or message, so a replay rewrites each whole', async () => {
    const { send } = rig()
    // A chunk with an id shows the agent numbers no messages, so only open items hold.
    await send(chunk('a', 'm1'))
    expect(await send(chunk('b', 'm1'))).toEqual([])
    // A call ends the message; the call holds until its final status.
    await send(
      update('tool_call', {
        toolCallId: 'c1',
        status: 'in_progress',
        rawOutput: { status: 'completed' }
      })
    )
    expect(await send(update('tool_call_update', { toolCallId: 'c1', content: [] }))).toEqual([2])
    expect(
      await send(update('tool_call_update', { toolCallId: 'c1', status: 'completed' }))
    ).toEqual([2, 5])
    expect(await send(chunk('c', 'm2'), answer(1))).toEqual([2, 5, 7])
  })

  it("holds an unnumbered agent's turn from its first line until the answer, unless the daemon asks", async () => {
    const { output, acks, send } = rig()
    await send(update('tool_call', { toolCallId: 'c1' }))
    await send(update('tool_call_update', { toolCallId: 'c1', status: 'failed' }))
    // Without ids its messages are numbered from the turn's start, so nothing in the turn is acked.
    expect(await send(chunk('a'), chunk('b'))).toEqual([])
    await output.settle(true)
    expect(acks).toEqual([4])
    expect(await send(chunk('c'))).toEqual([4])
    expect(await send(answer(1))).toEqual([4, 6])
  })
})
