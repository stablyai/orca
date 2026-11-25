import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import { ProviderRelayAckBatch, RELAY_ACK_CADENCE_MS } from './provider-relay-ack-batch'

describe('relay acks per daemon connection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs every due ack on one shared tick and sends them as one request; a refused one fails alone', async () => {
    const requests: { type: string; payload: unknown }[] = []
    const client = {
      getDaemonIdentity: () => ({ providerRelayAcks: true }),
      request: async (type: string, payload: unknown) => {
        requests.push({ type, payload })
        return { results: [{ ackedThrough: 4 }, { error: 'Relay not attached' }] }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the batch calls only request and getDaemonIdentity
    const batch = new ProviderRelayAckBatch(client as unknown as DaemonClient)
    const replies: Promise<string>[] = []
    const outcome = (reply: Promise<unknown>) =>
      reply.then(
        () => 'acked',
        () => 'refused'
      )
    batch.schedule(() => replies.push(outcome(batch.ack({ relayId: 'a', seq: 4 }))))
    batch.schedule(() => replies.push(outcome(batch.ack({ relayId: 'b', seq: 9 }))))
    const taken = batch.schedule(() => replies.push(outcome(batch.ack({ relayId: 'c', seq: 1 }))))
    taken()
    await vi.advanceTimersByTimeAsync(RELAY_ACK_CADENCE_MS + 100)
    expect(requests).toEqual([
      {
        type: 'relayAcks',
        payload: {
          acks: [
            { relayId: 'a', seq: 4 },
            { relayId: 'b', seq: 9 }
          ]
        }
      }
    ])
    expect(await Promise.all(replies)).toEqual(['acked', 'refused'])
    // Nothing due: no timer runs and nothing is sent.
    await vi.advanceTimersByTimeAsync(RELAY_ACK_CADENCE_MS * 3)
    expect(requests).toHaveLength(1)
  })

  it('sends each ack on its own, on the same shared tick, to a daemon without relayAcks', async () => {
    const requests: string[] = []
    const client = {
      getDaemonIdentity: () => ({ providerRelay: true }),
      request: async (type: string, payload: unknown) => {
        requests.push(`${type} ${JSON.stringify(payload)}`)
        return { ackedThrough: 1 }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the batch calls only request and getDaemonIdentity
    const batch = new ProviderRelayAckBatch(client as unknown as DaemonClient)
    const acked: unknown[] = []
    batch.schedule(
      () => void batch.ack({ relayId: 'a', seq: 4 }).then((reply) => acked.push(reply))
    )
    batch.schedule(
      () => void batch.ack({ relayId: 'b', seq: 9 }).then((reply) => acked.push(reply))
    )
    await vi.advanceTimersByTimeAsync(RELAY_ACK_CADENCE_MS - 1)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toEqual([
      'relayAck {"relayId":"a","seq":4}',
      'relayAck {"relayId":"b","seq":9}'
    ])
    expect(acked).toHaveLength(2)
  })
})
