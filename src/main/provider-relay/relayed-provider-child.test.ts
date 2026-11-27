import { describe, expect, it } from 'vitest'
import {
  EMPTY_RELAY_ATTACH,
  fakeProviderRelayChannel
} from './fake-provider-relay-channel.test-fixture'
import { jsonProperty } from '../../shared/json-stream/json-value-property'
import { RelayedProviderChild } from './relayed-provider-child'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'

const policy = () => ({ idleStopMs: null, markers: [] })
/** Enough event-loop turns for every write, ack and exit already queued to play out. */
const turns = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('relayed provider child', () => {
  it('an agent that exits during the attach still hands on its last output before its exit', async () => {
    const relay = fakeProviderRelayChannel({
      // The daemon sends the held request, the spool after the cursor, then the exit, then replies.
      attach: async () => {
        relay.sink().line('relayPending', 3, 'ask')
        relay.sink().line('relayData', 2, 'two')
        relay.sink().line('relayData', 3, 'ask')
        relay.sink().exit({ code: 0, signal: null })
        return {
          replayThroughSeq: 3,
          pending: [3],
          maxClientRequestId: 7,
          initializeResultSent: false,
          stderrTail: '',
          exit: { code: 0, signal: null }
        }
      }
    })
    const { channel } = relay
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
    const acks: number[] = []
    const relay = fakeProviderRelayChannel({
      attach: async () => {
        relay.sink().line('relayData', 5, 'five')
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
      }
    })
    const { channel } = relay
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
    relay.sink().line('relayData', 6, 'six')
    relay.sink().exit({ code: 0, signal: null })
    await turns()
    // The chat isn't ready yet: nothing reaches it, nothing is acked, and it hasn't ended.
    expect(order).toEqual([])
    expect(acks).toEqual([])
    expect(child.exited).toBeNull()

    child.releaseOutput()
    await new Promise((resolve) => child.once('close', resolve))
    expect(order).toEqual(['five', 'six', 'exit:0'])
    expect(acks).toEqual([6])
  })

  it('a paused reader hears of the exit only after it took the last lines', async () => {
    const relay = fakeProviderRelayChannel({
      attach: async () => EMPTY_RELAY_ATTACH
    })
    const { channel } = relay
    const child = new RelayedProviderChild({ channel, relayId: 'r', pid: 42, policy })
    const order: string[] = []
    // The journal drains after the first record, so the reader pauses there.
    const reader = createProviderRecordReader({
      stdout: child.stdout,
      onRecord: (record) => {
        order.push(String(jsonProperty(record, 'n')))
        if (order.length === 1) {
          reader.pause()
        }
      },
      onRejected: () => {},
      onFatal: () => {}
    })
    child.on('exit', (code) => order.push(`exit:${code}`))
    await child.start(0)
    for (const n of [1, 2, 3]) {
      relay.sink().line('relayData', n, JSON.stringify({ n }))
    }
    relay.sink().exit({ code: 0, signal: null })
    await turns()
    expect(order).toEqual(['1'])
    reader.resume()
    await new Promise((resolve) => child.once('close', resolve))
    expect(order).toEqual(['1', '2', '3', 'exit:0'])
  })

  it("a reattach reads the agent's initialize answer even when its stream event lands after the reply", async () => {
    const relay = fakeProviderRelayChannel({
      // The stream socket's preamble may land after the control socket's reply.
      attach: async () => {
        setTimeout(() => relay.sink().line('relayInitialize', 0, '{"id":1,"result":{}}'), 5)
        setTimeout(() => relay.sink().line('relayPending', 3, 'ask'), 5)
        return {
          replayThroughSeq: 3,
          pending: [3],
          maxClientRequestId: 1,
          initializeResultSent: true,
          stderrTail: '',
          exit: null
        }
      }
    })
    const { channel } = relay
    const child = new RelayedProviderChild({ channel, relayId: 'r', pid: 42, policy })
    await child.start(2)
    expect(child.initializeLine).toBe('{"id":1,"result":{}}')
  })
})
