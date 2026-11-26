// What a stream or call had on a socket of its own, it keeps on its host's one link: its own
// capabilities, no calls once it ended, and a status check pinned to the socket its call goes on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import {
  createSharedControlSubscription,
  replaySharedControlSubscriptions
} from '../../../../shared/remote-runtime/requests/remote-runtime-shared-control-subscriptions'
import type { SharedControlLogicalSubscription } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
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
let refusals = 0
const refuse = defineStreamingMethod({
  name: 'test.refuse',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async () => {
    refusals += 1
    throw new Error('refused')
  }
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
  refusals = 0
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('streams and calls on a host one link', () => {
  it(
    'reads a stream by its own capabilities, and refuses its calls once it ended',
    async () => {
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
    },
    // A real host through a cell.
    30_000
  )

  it(
    'never sends a vetted call on a socket other than the one its status came from',
    async () => {
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
    },
    // A real host through a cell, with a cut and reconnect.
    40_000
  )

  it(
    'fails only its own send for a frame too big for the host, and keeps the link',
    async () => {
      const { connection, link } = await startOneLinkHostBehindCell([caps], cleanups)
      let ends = 0
      const subscription = await openCapsStream(connection, () => void (ends += 1))
      const socket = link.socketGeneration.peek()
      expect(subscription.sendBinary(new Uint8Array(1024 * 1024))).toBe(false)
      expect((await link.request('status.get', undefined, 10_000)).ok).toBe(true)
      expect(link.socketGeneration.peek()).toBe(socket)
      expect(ends).toBe(0)
    },
    /* A real host through a cell. */ 30_000
  )

  it(
    'ends a stream the host refused, and never replays it on the next socket',
    async () => {
      const { cell, connection, link } = await startOneLinkHostBehindCell([refuse], cleanups)
      const errors: unknown[] = []
      await subscribeRemoteRuntimeTransport(connection, 'test.refuse', null, 10_000, {
        onResponse: (response) => errors.push(response.ok ? null : response.error.code),
        onError: () => {}
      })
      await vi.waitFor(() => expect(errors).toHaveLength(1))
      expect(link.getDiagnostics().subscriptionCount).toBe(0)
      const before = link.socketGeneration.peek()
      cell.cut()
      await vi.waitFor(() => expect(link.socketGeneration.peek()).not.toBe(before), {
        timeout: 15_000
      })
      expect((await link.request('status.get', undefined, 10_000)).ok).toBe(true)
      expect(refusals).toBe(1)
    },
    /* A real host through a cell, with a cut and reconnect. */ 40_000
  )

  it(
    'tells every stream owner the link dropped, even when one handler throws',
    async () => {
      const { cell, connection } = await startOneLinkHostBehindCell([caps], cleanups)
      let heard = 0
      await openCapsStream(connection, () => {
        throw new Error('owner failed')
      })
      await openCapsStream(connection, () => void (heard += 1))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      cell.cut()
      await vi.waitFor(() => expect(heard).toBe(1), { timeout: 15_000 })
      warn.mockRestore()
    },
    /* A real host through a cell, with a cut. */ 30_000
  )

  it(
    'ends its streams when the link itself is closed',
    async () => {
      const { connection, link } = await startOneLinkHostBehindCell([caps], cleanups)
      let ends = 0
      await openCapsStream(connection, () => void (ends += 1))
      link.close()
      expect(ends).toBe(1)
    },
    /* A real host through a cell. */ 30_000
  )
})

describe('closing a link before a stream started', () => {
  it(
    'rejects the stream without telling its owner it closed',
    async () => {
      const { connection, link } = await startOneLinkHostBehindCell([caps], cleanups)
      let ends = 0
      const opening = openCapsStream(connection, () => void (ends += 1))
      link.close()
      await expect(opening).rejects.toThrow()
      expect(ends).toBe(0)
    },
    /* A real host through a cell. */ 30_000
  )
})

describe('replaying JSON streams on a new socket', () => {
  it('replays a JSON stream but never a stream on a binary channel', () => {
    const subscriptions = new Map<string, SharedControlLogicalSubscription<unknown>>()
    const callbacks = { onResponse: () => {}, onError: () => {} }
    for (const [requestId, method] of [
      ['json', 'files.watch'],
      ['channel', 'terminal.multiplex']
    ]) {
      subscriptions.set(
        requestId,
        createSharedControlSubscription({
          requestId,
          method,
          params: null,
          retainedParamsBytes: 0,
          callbacks
        })
      )
    }
    subscriptions.get('channel')!.binaryChannel = 1
    const sent: string[] = []
    replaySharedControlSubscriptions({ subscriptions, send: (s) => void sent.push(s.requestId) })
    expect(sent).toEqual(['json'])
  })
})

function openCapsStream(
  connection: Parameters<typeof subscribeRemoteRuntimeTransport>[0],
  onClose: () => void
) {
  return subscribeRemoteRuntimeTransport(connection, 'test.caps', null, 10_000, {
    onResponse: () => {},
    onError: () => {},
    onClose
  })
}
