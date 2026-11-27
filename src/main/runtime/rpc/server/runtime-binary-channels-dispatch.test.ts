// Binary channels end to end through a real host: admission, release when a stream ends, a
// subscribe that outlives its handler, and two binary streams on one authenticated socket.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import {
  pairedRuntimeConnectionFromOffer,
  pairedRuntimeConnectionToken
} from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  BinaryChannelOpcode,
  decodeBinaryChannelFrame,
  encodeBinaryChannelFrame,
  MAX_OPEN_BINARY_CHANNELS,
  RUNTIME_BINARY_CHANNELS_CAPABILITY
} from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import { sendRemoteRuntimeTokenAuth } from '../../../../shared/remote-runtime/remote-runtime-client-handshake'
import {
  acceptSealedReady,
  openSealedFrame
} from '../../../../shared/remote-runtime/remote-runtime-sealed-frame'
import { openRemoteRuntimeWebSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-websocket'
import { defineStreamingMethod } from '../core'
import { STATUS_METHODS } from '../methods/host-management/status'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

// Echoes each binary frame back with its own tag, until its connection goes away.
const echo = defineStreamingMethod({
  name: 'test.echo',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: (_params, { sendBinary, registerBinaryMessageHandler, signal }, emit) =>
    new Promise<void>((resolve) => {
      let tag = 0
      registerBinaryMessageHandler?.((bytes) => {
        tag ||= bytes[0]
        sendBinary?.(Uint8Array.of(tag, bytes.length))
      })
      emit({ type: 'ready' })
      signal?.addEventListener('abort', () => resolve())
    })
})
// Ends on its own right after it starts, as a finished download copy does.
const brief = defineStreamingMethod({
  name: 'test.brief',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async (_params, _context, emit) => {
    emit({ type: 'end' })
  }
})
// Registers and returns at once, as agentSession.subscribe does; its rows come later.
const liveStreams = new Map<string, (row: unknown) => void>()
const streamReleases: string[] = []
const subscribe = defineStreamingMethod({
  name: 'test.subscribe',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async (_params, { runtime, connectionId, signal }, emit) => {
    const id = connectionId!
    liveStreams.set(id, emit)
    let released = false
    const release = (): void => {
      if (!released) {
        released = true
        liveStreams.delete(id)
        streamReleases.push(id)
      }
    }
    signal?.addEventListener('abort', release)
    runtime.registerSubscriptionCleanup(`test-subscribe-${id}`, release, id)
    emit({ type: 'ready' })
  }
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function connect(clientCapabilities: string[]) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-binary-channels-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    methods: [...STATUS_METHODS, echo, brief, subscribe]
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
  const connection = pairedRuntimeConnectionFromOffer(parsePairingCode(offer.pairingUrl)!)
  const texts: { id: string; ok: boolean; result?: unknown; error?: { message: string } }[] = []
  const binaries: Uint8Array[] = []
  const authenticated = Promise.withResolvers<void>()
  let phase: 'ready' | 'auth' | 'open' = 'ready'
  const opened = openRemoteRuntimeWebSocket(connection, {
    onClose: () => {},
    onError: (_ws, error) => authenticated.reject(error),
    onFrame: (ws, frame) => {
      const { handshake } = socket
      if (phase === 'ready') {
        expect(acceptSealedReady(handshake, frame)).toBe('accepted')
        phase = 'auth'
        void sendRemoteRuntimeTokenAuth({
          handshake,
          deviceToken: pairedRuntimeConnectionToken(connection),
          clientCapabilities,
          stillAwaiting: () => true,
          send: (sealed) => ws.send(sealed),
          fail: (error) => authenticated.reject(error)
        })
        return
      }
      const plain = openSealedFrame(handshake, frame)
      if (phase === 'auth') {
        phase = 'open'
        authenticated.resolve()
      } else if (plain.kind === 'text') {
        texts.push(JSON.parse(plain.text))
      } else if (plain.kind === 'binary') {
        binaries.push(plain.bytes)
      }
    }
  })
  if (!opened.ok) {
    throw opened.error
  }
  const socket = opened.socket
  cleanups.push(() => {
    socket.cleanup()
    socket.ws.close()
  })
  await authenticated.promise
  let nextId = 0
  const request = (method: string, binaryChannel?: unknown): string => {
    const id = `r${++nextId}`
    socket.ws.send(
      socket.handshake.channel.sealText(
        JSON.stringify({
          id,
          deviceToken: pairedRuntimeConnectionToken(connection),
          method,
          params: null,
          ...(binaryChannel === undefined ? {} : { binaryChannel })
        })
      )
    )
    return id
  }
  const sendBinary = (bytes: Uint8Array): void => {
    socket.ws.send(socket.handshake.channel.sealBinary(bytes))
  }
  const reply = (id: string) =>
    vi.waitFor(() => {
      const found = texts.find((text) => text.id === id)
      if (!found) {
        throw new Error(`no reply to ${id} yet`)
      }
      return found
    })
  const closeSocket = (): void => socket.ws.close()
  return { request, sendBinary, reply, texts, binaries, closeSocket }
}

const data = (channel: number, payload: Uint8Array): Uint8Array =>
  encodeBinaryChannelFrame({ opcode: BinaryChannelOpcode.Data, channel, payload })

describe('binary channels through the host', () => {
  it('carries two binary streams on one socket, each only its own frames', async () => {
    const client = await connect([RUNTIME_BINARY_CHANNELS_CAPABILITY])
    await client.reply(client.request('test.echo', 1))
    await client.reply(client.request('test.echo', 2))
    client.sendBinary(data(2, Uint8Array.of(0xb2, 0, 0)))
    client.sendBinary(data(1, Uint8Array.of(0xa1)))
    await vi.waitFor(() => expect(client.binaries).toHaveLength(2))
    const frames = client.binaries.map((bytes) => decodeBinaryChannelFrame(bytes)!)
    expect(frames.map((f) => [f.channel, ...f.payload])).toEqual([
      [2, 0xb2, 3],
      [1, 0xa1, 1]
    ])

    // Closing channel 1 ends its stream on the host; channel 2 keeps working.
    client.sendBinary(
      encodeBinaryChannelFrame({
        opcode: BinaryChannelOpcode.Close,
        channel: 1,
        payload: new Uint8Array()
      })
    )
    client.sendBinary(data(1, Uint8Array.of(0xa1)))
    client.sendBinary(data(2, Uint8Array.of(0xb2)))
    await vi.waitFor(() => expect(client.binaries).toHaveLength(3))
    expect(decodeBinaryChannelFrame(client.binaries[2])?.channel).toBe(2)
  })

  it('releases a channel when its stream ends, so ended streams never use up the slots', async () => {
    const client = await connect([RUNTIME_BINARY_CHANNELS_CAPABILITY])
    for (let channel = 1; channel <= MAX_OPEN_BINARY_CHANNELS + 4; channel += 1) {
      const response = await client.reply(client.request('test.brief', channel))
      expect(response.ok).toBe(true)
    }
    // A refused request releases the channel it named, too.
    expect((await client.reply(client.request('no.such.method', 1))).ok).toBe(false)
    expect((await client.reply(client.request('test.echo', 1))).ok).toBe(true)
  })

  it('keeps a subscribe on a channel alive after its handler returns, until the stream ends', async () => {
    streamReleases.length = 0
    const client = await connect([RUNTIME_BINARY_CHANNELS_CAPABILITY])
    const ids = [1, 2, 3].map((channel) => client.request('test.subscribe', channel))
    for (const id of ids) {
      expect((await client.reply(id)).result).toEqual({ type: 'ready' })
    }
    const live = [...liveStreams.keys()].filter((id) => /#[123]$/.test(id)).sort()
    expect(live).toHaveLength(3)
    const [first, second, third] = live
    const rows = (id: string) => client.texts.filter((text) => text.id === id).map((t) => t.result)

    // Rows reach the client after the handler has long returned.
    liveStreams.get(first)!({ type: 'batch', n: 1 })
    await vi.waitFor(() => expect(rows(ids[0])).toContainEqual({ type: 'batch', n: 1 }))
    expect(streamReleases).toEqual([])

    // Each ends exactly once: by its own `end`, the client closing its channel, or the link dropping.
    liveStreams.get(first)!({ type: 'end' })
    await vi.waitFor(() => expect(streamReleases).toEqual([first]))
    client.sendBinary(
      encodeBinaryChannelFrame({
        opcode: BinaryChannelOpcode.Close,
        channel: 2,
        payload: new Uint8Array()
      })
    )
    await vi.waitFor(() => expect(streamReleases).toEqual([first, second]))
    client.closeSocket()
    await vi.waitFor(() => expect(streamReleases).toEqual([first, second, third]))
  })

  it('refuses a channel to a client that did not advertise them, or a bad channel number', async () => {
    const plain = await connect([])
    expect((await plain.reply(plain.request('test.echo', 1))).error?.message).toBe(
      'Binary channels are not available on this connection.'
    )
    const client = await connect([RUNTIME_BINARY_CHANNELS_CAPABILITY])
    for (const bad of [0, -1, '1', 1.5, 2 ** 32]) {
      expect((await client.reply(client.request('test.echo', bad))).error?.message).toBe(
        'Binary channel must be an integer from 1 to 2^32-1.'
      )
    }
  })
})
