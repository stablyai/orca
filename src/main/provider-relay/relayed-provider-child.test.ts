import { describe, expect, it } from 'vitest'
import type { ProviderRelayChannel, ProviderRelaySink } from './provider-relay-channel'
import { RelayedProviderChild } from './relayed-provider-child'

const policy = () => ({ idleStopMs: null, markers: [] })

describe('relayed provider child', () => {
  it('an agent that exits during the attach still hands on its last output before its exit', async () => {
    let sink = null as ProviderRelaySink | null
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

  it('an agent that exits while its output is held for a reattach waits for the chat, then ends', async () => {
    let sink = null as ProviderRelaySink | null
    const acks: number[] = []
    const channel = {
      bind: (_relayId: string, bound: ProviderRelaySink) => {
        sink = bound
        return () => {}
      },
      attach: async () => {
        sink?.line('relayData', 5, 'five')
        return {
          replayThroughSeq: 5,
          pending: [],
          maxClientRequestId: null,
          initializeResultSent: false,
          stderrTail: '',
          exit: null
        }
      },
      ack: async (_relayId: string, seq: number) => {
        acks.push(seq)
        return {}
      },
      close: async () => ({})
    } as unknown as ProviderRelayChannel
    const child = new RelayedProviderChild({
      channel,
      relayId: 'r',
      pid: 42,
      policy,
      passWhileHeld: () => false
    })
    const order: string[] = []
    child.stdout.on('data', (chunk: Buffer) => order.push(...chunk.toString().trim().split('\n')))
    child.on('exit', (code) => order.push(`exit:${code}`))
    await child.start(4)
    sink?.line('relayData', 6, 'six')
    sink?.exit({ code: 0, signal: null })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The chat isn't ready yet: nothing reaches it, nothing is acked, and it hasn't ended.
    expect(order).toEqual([])
    expect(acks).toEqual([])
    expect(child.exited).toBeNull()

    child.releaseOutput()
    await new Promise((resolve) => child.once('close', resolve))
    expect(order).toEqual(['five', 'six', 'exit:0'])
    expect(acks).toEqual([6])
  })
})
