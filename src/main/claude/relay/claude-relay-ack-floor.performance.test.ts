import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RelayedProviderOutput } from '../../provider-relay/relayed-provider-output'
import { claudeRelayAckFloor } from './claude-relay-ack-floor'

const frame = (value: unknown) => JSON.stringify(value)

// A chat holding an approval gets a keep-alive every 30 s; it must not wake the app to ack.
describe('Claude relay ack floor wake-ups', () => {
  it('arms no ack for a keep-alive, which the next real line covers', async () => {
    const acks: number[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ack: async (seq) => {
        acks.push(seq)
      },
      ackFloor: claudeRelayAckFloor()
    })
    vi.useFakeTimers()
    try {
      output.line('relayData', 1, frame({ type: 'keep_alive' }))
      expect(vi.getTimerCount()).toBe(0)
      output.line('relayData', 2, frame({ type: 'system', subtype: 'status', session_id: 's' }))
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
    await output.settle()
    expect(acks).toEqual([2])
  })
})
