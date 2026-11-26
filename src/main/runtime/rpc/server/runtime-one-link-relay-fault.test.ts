// One link per host through a stand-in Relay cell with the cell's real limits: calls, JSON streams
// and several credit-windowed binary streams share one socket, survive a cut mid-burst and a slow
// client, and no frame ever reaches the wrong stream.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import {
  clearRemoteRuntimeOneLink,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { defineMethod, defineStreamingMethod } from '../core'
import { STATUS_METHODS } from '../methods/host-management/status'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { startRelayCellStandIn } from '../testing/relay-cell-stand-in'

const FRAME_BYTES = 16 * 1024
// Like a terminal stream's ack window: the host sends at most this far ahead of the client's acks.
const WINDOW_BYTES = 256 * 1024

// Bursts running on the host, by tag.
const runningBursts = new Map<number, number>()

// A burst like a chatty terminal's: tagged frames as fast as the client's acks allow.
const burst = defineStreamingMethod({
  name: 'test.burst',
  permission: 'workspace',
  share: 'not-shared',
  params: z.object({ tag: z.number().int() }),
  handler: ({ tag }, { sendBinary, registerBinaryMessageHandler, signal }, emit) =>
    new Promise<void>((resolve) => {
      let inFlight = 0
      let seq = 0
      let wake: (() => void) | null = null
      runningBursts.set(tag, (runningBursts.get(tag) ?? 0) + 1)
      registerBinaryMessageHandler?.((bytes) => {
        inFlight -= bytes[1] * FRAME_BYTES
        wake?.()
      })
      signal?.addEventListener('abort', () => {
        runningBursts.set(tag, runningBursts.get(tag)! - 1)
        wake?.()
        resolve()
      })
      emit({ type: 'ready' })
      void (async () => {
        while (!signal?.aborted) {
          if (inFlight + FRAME_BYTES > WINDOW_BYTES) {
            await new Promise<void>((next) => (wake = next))
            wake = null
            continue
          }
          const frame = new Uint8Array(FRAME_BYTES)
          frame[0] = tag
          new DataView(frame.buffer).setUint32(1, ++seq, true)
          inFlight += FRAME_BYTES
          sendBinary?.(frame)
          await new Promise((next) => setImmediate(next))
        }
      })()
    })
})
const ticks = defineStreamingMethod({
  name: 'test.ticks',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: (_params, { signal }, emit) =>
    new Promise<void>((resolve) => {
      const timer = setInterval(() => emit({ tick: Date.now() }), 50)
      signal?.addEventListener('abort', () => {
        clearInterval(timer)
        resolve()
      })
    })
})
const big = defineMethod({
  name: 'test.big',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async () => ({ text: 'x'.repeat(3 * 1024 * 1024) })
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  runningBursts.clear()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startHostBehindCell() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-one-link-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    methods: [...STATUS_METHODS, burst, ticks, big]
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop().catch(() => {})
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime', name: 'Desk' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const direct = pairedRuntimeConnectionFromOffer(parsePairingCode(offer.pairingUrl)!)
  const cell = await startRelayCellStandIn(direct.endpoint)
  cleanups.push(() => cell.close())
  const connection = { ...direct, endpoint: cell.url }
  const link = new RemoteRuntimeSharedControlConnection(connection, {
    environmentId: 'one-link-test',
    binaryChannels: true,
    appHeartbeat: {}
  })
  setRemoteRuntimeOneLink('one-link-test', connection, () => link)
  cleanups.push(() => {
    clearRemoteRuntimeOneLink('one-link-test')
    link.close()
  })
  return { server, cell, connection, link }
}

type Stream = { tag: number; frames: number; wrong: number; close: () => void }

async function openBurst(
  connection: Parameters<typeof subscribeRemoteRuntimeTransport>[0],
  tag: number
): Promise<Stream> {
  const stream: Stream = { tag, frames: 0, wrong: 0, close: () => {} }
  let ack: (bytes: Uint8Array) => boolean = () => false
  const subscription = await subscribeRemoteRuntimeTransport(
    connection,
    'test.burst',
    { tag },
    10_000,
    {
      onResponse: () => {},
      onBinary: (bytes) => {
        if (bytes[0] === tag && bytes.byteLength === FRAME_BYTES) {
          stream.frames += 1
        } else {
          stream.wrong += 1
        }
        ack(Uint8Array.of(tag, 1))
      },
      onError: () => {}
    }
  )
  ack = subscription.sendBinary
  stream.close = subscription.close
  return stream
}

describe('one link per host through a Relay cell', () => {
  it('carries calls, streams and binary on one socket, and resumes all of them after a cut', async () => {
    const { server, cell, connection, link } = await startHostBehindCell()
    expect((await link.request('status.get', { probe: true }, 10_000)).ok).toBe(true)
    const streams = await Promise.all([1, 2, 3].map((tag) => openBurst(connection, tag)))
    let tickCount = 0
    await link.subscribe('test.ticks', null, 10_000, {
      onResponse: () => {
        tickCount += 1
      },
      onError: () => {}
    })
    // A one-shot call and a 3 MiB reply ride the same link while the bursts run.
    expect(
      (await sendRemoteRuntimeRequestOnSocket(connection, 'status.get', undefined, 10_000)).ok
    ).toBe(true)
    expect((await link.request('test.big', null, 20_000)).ok).toBe(true)
    await vi.waitFor(() => expect(streams.every((s) => s.frames > 50)).toBe(true), {
      timeout: 20_000
    })
    expect(server.readClientActivity().openConnections).toBeLessThanOrEqual(1)

    // Cut mid-burst: every stream comes back on the new link with only its own frames.
    const before = streams.map((s) => s.frames)
    const ticksBefore = tickCount
    cell.cut()
    await vi.waitFor(
      () => {
        expect(streams.every((s, i) => s.frames > before[i] + 50)).toBe(true)
        expect(tickCount).toBeGreaterThan(ticksBefore + 5)
      },
      { timeout: 20_000 }
    )
    expect((await link.request('status.get', { probe: true }, 10_000)).ok).toBe(true)
    expect(streams.map((s) => s.wrong)).toEqual([0, 0, 0])
    expect(cell.limitCloses).toEqual([])

    // The cut ended the old bursts; exactly one of each runs on the new link.
    expect([...runningBursts.entries()].sort()).toEqual([
      [1, 1],
      [2, 1],
      [3, 1]
    ])

    // A closed stream ends on the host; the others keep flowing.
    streams[0].close()
    await vi.waitFor(() => expect(runningBursts.get(1)).toBe(0), { timeout: 10_000 })
    const afterClose = streams.map((s) => s.frames)
    await vi.waitFor(
      () =>
        expect(
          streams[1].frames > afterClose[1] + 20 && streams[2].frames > afterClose[2] + 20
        ).toBe(true),
      { timeout: 20_000 }
    )
  }, 90_000)

  it('rides out a slow client without tripping the cell, then catches up', async () => {
    const { cell, connection, link } = await startHostBehindCell()
    const streams = await Promise.all([1, 2].map((tag) => openBurst(connection, tag)))
    await vi.waitFor(() => expect(streams.every((s) => s.frames > 20)).toBe(true), {
      timeout: 20_000
    })
    cell.stallClient(3_000)
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    const before = streams.map((s) => s.frames)
    await vi.waitFor(() => expect(streams.every((s, i) => s.frames > before[i] + 50)).toBe(true), {
      timeout: 20_000
    })
    expect(cell.limitCloses).toEqual([])
    expect(streams.map((s) => s.wrong)).toEqual([0, 0])
    expect(link.getDiagnostics().reconnectAttempt).toBe(0)
  }, 60_000)
})
