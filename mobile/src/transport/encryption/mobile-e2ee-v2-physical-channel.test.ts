import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'

import { gzipSync } from 'node:zlib'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Ready
} from '../../../../src/shared/remote-runtime/e2ee/mobile-e2ee-v2-contract'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../../src/shared/remote-runtime/e2ee/mobile-e2ee-v2-framing'
import { encodeCompressedFrame } from '../../../../src/shared/remote-runtime/e2ee/paired-e2ee-compressed-frame'

vi.mock('./direct-e2ee-framing-policy', async () => {
  const { createPairedE2EEFramingPolicy } =
    await import('../../../../src/shared/remote-runtime/e2ee/paired-e2ee-framing-policy')
  return {
    createDirectE2EEFramingPolicy: (key: string) =>
      createPairedE2EEFramingPolicy(key, {
        hydrate: async () => {},
        isLatched: () => true,
        latch: () => {}
      })
  }
})
vi.mock('../mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { deriveSharedKey } from './e2ee'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { derivePairedE2EEV2KeySchedule as deriveMobileE2EEV2KeySchedule } from '../../../../src/shared/remote-runtime/e2ee/paired-e2ee-v2-key-schedule'
import {
  MobileE2EEAuthenticationError,
  MobileE2EEV2PhysicalChannel,
  type MobileE2EEV2Socket
} from './mobile-e2ee-v2-physical-channel'

const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))

function setup(
  decodeBinary: (raw: unknown) => Promise<Uint8Array | null>,
  transport: 'direct' | 'relay' = 'relay'
) {
  const session = MobileE2EEV2ClientSession.create({
    desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
    transport,
    ...(transport === 'relay' ? { relayHostId: 'AbCdEf0123_-xyZ9' } : {}),
    clientNonce: new Uint8Array(32).fill(3),
    clientKeyPair: client
  })
  const sent: (string | Uint8Array)[] = []
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string | Uint8Array) => sent.push(frame)
  } satisfies MobileE2EEV2Socket
  const events: string[] = []
  const onAuthenticated = vi.fn(() => events.push('authenticated'))
  const onError = vi.fn()
  const channel = new MobileE2EEV2PhysicalChannel({
    session,
    socket,
    deviceToken: 'valid-token',
    decodeBinary,
    onAuthenticated,
    onText: (plaintext) => events.push(`text:${plaintext}`),
    onBinary: (plaintext) => events.push(`binary:${plaintext[0]}`),
    onError
  })
  channel.start()

  const ready: MobileE2EEV2Ready = {
    type: 'e2ee_ready',
    v: 2,
    desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
    clientNonceB64: session.hello.clientNonceB64,
    desktopNonceB64: Buffer.from(new Uint8Array(32).fill(4)).toString('base64'),
    selection: { framing: 2, payloadKinds: ['text', 'binary'] },
    context: session.hello.context
  }
  const handshake = validateMobileE2EEV2Handshake(session.hello, ready)!
  const schedule = deriveMobileE2EEV2KeySchedule({
    sharedSecret: deriveSharedKey(desktop.secretKey, client.publicKey),
    transcript: encodeMobileE2EEV2Transcript(handshake),
    clientNonce: handshake.clientNonce,
    desktopNonce: handshake.desktopNonce
  })
  return { channel, session, socket, sent, events, onAuthenticated, onError, ready, schedule }
}

function serverFrame(
  payload: Uint8Array,
  kind: 'text' | 'binary',
  counter: bigint,
  schedule: ReturnType<typeof setup>['schedule']
): Uint8Array {
  return sealMobileE2EEV2Frame({
    payload,
    key: schedule.desktopToMobileKey,
    sessionId: schedule.sessionId,
    direction: 'desktop-to-mobile',
    payloadKind: kind,
    counter
  })
}

async function authenticate(ctx: ReturnType<typeof setup>): Promise<void> {
  await ctx.channel.handleMessage(JSON.stringify(ctx.ready))
  const response = serverFrame(
    new TextEncoder().encode(
      JSON.stringify({
        type: 'e2ee_authenticated',
        v: 2,
        transcriptHashB64: ctx.session.transcriptHashB64
      })
    ),
    'text',
    0n,
    ctx.schedule
  )
  await ctx.channel.handleMessage(Buffer.from(response).toString('base64'))
}

describe('mobile E2EE v2 physical channel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('classifies the encrypted desktop device-token rejection as global auth failure', async () => {
    const ctx = setup(async () => null)
    await ctx.channel.handleMessage(JSON.stringify(ctx.ready))
    const rejection = serverFrame(
      new TextEncoder().encode(
        JSON.stringify({ type: 'e2ee_error', error: { code: 'unauthorized' } })
      ),
      'text',
      0n,
      ctx.schedule
    )

    await ctx.channel.handleMessage(Buffer.from(rejection).toString('base64'))

    expect(ctx.onError.mock.calls[0]![0]).toBeInstanceOf(MobileE2EEAuthenticationError)
    expect(ctx.onAuthenticated).not.toHaveBeenCalled()
  })

  it('serializes delayed binary conversion before a later text counter', async () => {
    let releaseBinary!: (bytes: Uint8Array) => void
    const pendingBinary = new Promise<Uint8Array>((resolve) => (releaseBinary = resolve))
    const ctx = setup(async () => pendingBinary)
    await authenticate(ctx)
    ctx.events.length = 0

    const binary = serverFrame(new Uint8Array([7]), 'binary', 1n, ctx.schedule)
    const text = serverFrame(new TextEncoder().encode('later'), 'text', 2n, ctx.schedule)
    const first = ctx.channel.handleMessage({ delayedBlob: true })
    const second = ctx.channel.handleMessage(Buffer.from(text).toString('base64'))
    await Promise.resolve()
    expect(ctx.events).toEqual([])

    releaseBinary(binary)
    await Promise.all([first, second])
    expect(ctx.events).toEqual(['binary:7', 'text:later'])
    expect(ctx.onError).not.toHaveBeenCalled()
  })

  it('delivers compressed frames as what they carry, in counter order with plain frames', async () => {
    const ctx = setup(async (raw) => (raw instanceof Uint8Array ? raw : null))
    await authenticate(ctx)
    ctx.events.length = 0

    const reply = JSON.stringify({ id: 'rpc-1', ok: true, result: { note: 'é'.repeat(4096) } })
    const utf8 = Buffer.from(reply, 'utf8')
    const text = encodeCompressedFrame({
      payloadKind: 'text',
      inflatedByteLength: utf8.byteLength,
      gzipped: gzipSync(utf8)
    })
    const terminal = new Uint8Array(2048).fill(0x74)
    const binary = encodeCompressedFrame({
      payloadKind: 'binary',
      inflatedByteLength: terminal.byteLength,
      gzipped: gzipSync(terminal)
    })
    await ctx.channel.handleMessage(serverFrame(text, 'binary', 1n, ctx.schedule))
    await ctx.channel.handleMessage(serverFrame(binary, 'binary', 2n, ctx.schedule))
    await ctx.channel.handleMessage(serverFrame(new Uint8Array([7]), 'binary', 3n, ctx.schedule))

    expect(ctx.events).toEqual([`text:${reply}`, 'binary:116', 'binary:7'])
    expect(ctx.onError).not.toHaveBeenCalled()
  })

  it('queues outbound text and binary in one counter order', async () => {
    const ctx = setup(async () => null)
    await authenticate(ctx)
    ctx.socket.bufferedAmount = 9 * 1024 * 1024
    expect(ctx.channel.sendText('one')).toBe(true)
    expect(ctx.channel.sendBinary(new Uint8Array([2]))).toBe(true)
    expect(ctx.sent).toHaveLength(2)

    ctx.socket.bufferedAmount = 0
    vi.runOnlyPendingTimers()
    expect(typeof ctx.sent[2]).toBe('string')
    expect(ctx.sent[3]).toBeInstanceOf(Uint8Array)
    expect(
      openMobileE2EEV2Frame({
        frame: Buffer.from(ctx.sent[2] as string, 'base64'),
        key: ctx.schedule.mobileToDesktopKey,
        sessionId: ctx.schedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'text',
        expectedCounter: 1n
      })
    ).toEqual(new TextEncoder().encode('one'))
    expect(
      openMobileE2EEV2Frame({
        frame: ctx.sent[3] as Uint8Array,
        key: ctx.schedule.mobileToDesktopKey,
        sessionId: ctx.schedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'binary',
        expectedCounter: 2n
      })
    ).toEqual(new Uint8Array([2]))
  })

  it('ignores queued and newly arriving frames after disposal', async () => {
    let releaseBinary!: (bytes: Uint8Array) => void
    const pendingBinary = new Promise<Uint8Array>((resolve) => (releaseBinary = resolve))
    const ctx = setup(async () => pendingBinary)
    await authenticate(ctx)
    ctx.events.length = 0

    const binary = serverFrame(new Uint8Array([7]), 'binary', 1n, ctx.schedule)
    const text = serverFrame(new TextEncoder().encode('retired'), 'text', 2n, ctx.schedule)
    const first = ctx.channel.handleMessage({ delayedBlob: true })
    const second = ctx.channel.handleMessage(Buffer.from(text).toString('base64'))
    await Promise.resolve()
    ctx.channel.dispose()

    const successor = setup(async () => null)
    await authenticate(successor)
    successor.events.length = 0
    const live = serverFrame(new TextEncoder().encode('successor'), 'text', 1n, successor.schedule)
    await successor.channel.handleMessage(Buffer.from(live).toString('base64'))
    expect(successor.events).toEqual(['text:successor'])
    expect(successor.onError).not.toHaveBeenCalled()

    releaseBinary(binary)
    await Promise.all([first, second])
    expect(ctx.events).toEqual([])

    const late = serverFrame(new TextEncoder().encode('late'), 'text', 1n, ctx.schedule)
    await ctx.channel.handleMessage(Buffer.from(late).toString('base64'))
    expect(ctx.events).toEqual([])
    expect(ctx.onError).not.toHaveBeenCalled()
  })
})
