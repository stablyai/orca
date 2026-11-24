import { describe, expect, it } from 'vitest'
import type { ProviderRelayChannel, ProviderRelaySink } from './provider-relay-channel'
import { RelayedProviderChild } from './relayed-provider-child'

const policy = () => ({ idleStopMs: null, markers: [] })

describe('relayed provider child', () => {
  it('an agent that exits during the attach still hands on its last output before its exit', async () => {
    let sink: ProviderRelaySink | null = null
    const channel = {
      bind: (_relayId: string, bound: ProviderRelaySink) => {
        sink = bound
        return () => {}
      },
      // The daemon sends the held request, the spool after the cursor, then the exit, then replies.
      attach: async () => {
        sink?.line('relayPending', 3, 'ask')
        sink?.line('relayData', 2, 'two')
        sink?.line('relayData', 3, 'ask')
        sink?.exit({ code: 0, signal: null })
        return {
          replayThroughSeq: 3,
          pending: [3],
          maxClientRequestId: 7,
          initializeResultSent: false,
          stderrTail: '',
          exit: { code: 0, signal: null }
        }
      },
      ack: async () => ({}),
      close: async () => ({})
    } as unknown as ProviderRelayChannel
    const child = new RelayedProviderChild({ channel, relayId: 'r', pid: 42, policy })
    const order: string[] = []
    child.stdout.on('data', (chunk: Buffer) => order.push(...chunk.toString().trim().split('\n')))
    child.on('exit', (code) => order.push(`exit:${code}`))

    await expect(child.start(1)).resolves.toMatchObject({ maxClientRequestId: 7 })
    await new Promise((resolve) => child.once('close', resolve))
    expect(order).toEqual(['ask', 'two', 'exit:0'])
    expect(child.exited).toEqual({ code: 0, signal: null })
  })
})
