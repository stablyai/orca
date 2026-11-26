// What a stream or call had on a socket of its own, it keeps on its host's one link: its own
// capabilities, no calls once it ended, and a status check pinned to the socket its call goes on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { defineMethod, defineStreamingMethod } from '../core'
import { startOneLinkHostBehindCell } from '../testing/one-link-host-behind-cell'

const STREAM_CAPABILITY = 'test.stream-only.v1'
let mutations = 0

const caps = defineStreamingMethod({
  name: 'test.caps',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: (_params, { clientCapabilities, signal }, emit) =>
    new Promise<void>((resolve) => {
      emit({ capabilities: clientCapabilities ?? [] })
      signal?.addEventListener('abort', () => resolve())
    })
})
const mutate = defineMethod({
  name: 'test.mutate',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async () => ({ count: ++mutations })
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  mutations = 0
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('streams and calls on a host one link', () => {
  it('reads a stream by its own capabilities, and refuses its calls once it ended', async () => {
    const { connection } = await startOneLinkHostBehindCell([caps, mutate], cleanups)
    const seen: unknown[] = []
    const subscription = await subscribeRemoteRuntimeTransport(
      connection,
      'test.caps',
      null,
      10_000,
      {
        onResponse: (response) => seen.push(response.ok ? response.result : null),
        onError: () => {}
      },
      { clientCapabilities: [STREAM_CAPABILITY] }
    )
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ capabilities: expect.arrayContaining([STREAM_CAPABILITY]) })

    expect((await subscription.sendRequest!('test.mutate', null, 10_000)).ok).toBe(true)
    subscription.close()
    await expect(subscription.sendRequest!('test.mutate', null, 10_000)).rejects.toThrow()
    expect(mutations).toBe(1)
  }, 30_000)

  it('never sends a vetted call on a socket other than the one its status came from', async () => {
    const { cell, connection, link } = await startOneLinkHostBehindCell([mutate], cleanups)
    expect((await link.request('status.get', undefined, 10_000)).ok).toBe(true)
    let reconnected = false
    const sent = sendRemoteRuntimeRequestOnSocket(
      connection,
      'test.mutate',
      null,
      20_000,
      undefined,
      (status) => expect(status.ok).toBe(true),
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      // Between the status and the call, the link drops and reconnects (to what could be a
      // restarted host).
      async () => {
        if (!reconnected) {
          reconnected = true
          const before = link.socketGeneration.peek()
          cell.cut()
          await vi.waitFor(
            () => {
              expect(link.socketGeneration.peek()).not.toBe(before)
              expect(link.getDiagnostics().state).toBe('ready')
            },
            { timeout: 15_000 }
          )
        }
        return () => true
      }
    )
    await expect(sent).rejects.toThrow()
    expect(mutations).toBe(0)
  }, 40_000)
})
