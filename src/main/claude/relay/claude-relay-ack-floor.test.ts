import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RelayedProviderOutput } from '../../provider-relay/relayed-provider-output'
import { claudeRelayAckFloor } from './claude-relay-ack-floor'

const frame = (value: unknown) => JSON.stringify(value)
const stream = (type: string) =>
  frame({ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type } })

describe('Claude relay ack floor', () => {
  it('never acks into a streamed message whose final frame has not landed', async () => {
    const acks: number[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ack: async (seq) => {
        acks.push(seq)
      },
      ackFloor: claudeRelayAckFloor()
    })
    output.line('relayData', 1, frame({ type: 'system', subtype: 'init', session_id: 's' }))
    output.line('relayData', 2, stream('message_start'))
    output.line('relayData', 3, stream('content_block_delta'))
    output.line('relayData', 4, stream('message_stop'))
    await output.settle()
    // A later attach replays from the message's start, so the new app rebuilds the same row.
    expect(acks).toEqual([1])
    output.line(
      'relayData',
      5,
      frame({ type: 'assistant', session_id: 's', parent_tool_use_id: null })
    )
    await output.settle()
    expect(acks).toEqual([1, 5])
    // An agent that ended mid-stream still gets everything acked, so the daemon can drop it.
    output.line('relayData', 6, stream('message_start'))
    await output.finish()
    expect(acks).toEqual([1, 5, 6])
  })
})
