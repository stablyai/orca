import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { sanitizeCrashReportString } from '../../../src/shared/crash-report-redaction'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Ready
} from '../../../src/shared/mobile-e2ee-v2-contract'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../src/shared/mobile-e2ee-v2-framing'

vi.mock('./direct-e2ee-framing-policy', async () => {
  const { createPairedE2EEFramingPolicy } =
    await import('../../../src/shared/paired-e2ee-framing-policy')
  return {
    createDirectE2EEFramingPolicy: (key: string) =>
      createPairedE2EEFramingPolicy(key, {
        hydrate: async () => {},
        isLatched: () => true,
        latch: () => {}
      })
  }
})
vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { deriveSharedKey } from './e2ee'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { derivePairedE2EEV2KeySchedule as deriveMobileE2EEV2KeySchedule } from '../../../src/shared/paired-e2ee-v2-key-schedule'
import {
  MobileE2EEAuthenticationError,
  MobileE2EEV2PhysicalChannel,
  type MobileE2EEV2Socket
} from './mobile-e2ee-v2-physical-channel'
import { connect } from './rpc-client'
import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'
import { connectMobileRelayForPairing } from './mobile-relay-physical-client'

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

function assertReleasedPhysicalChannel(channel: unknown): void {
  if (!(channel instanceof MobileE2EEV2PhysicalChannel)) {
    throw new Error('physical channel dispose receiver changed')
  }
  const queue = channel['outboundQueue']
  if (!queue || typeof queue.evidence !== 'function') {
    throw new Error('physical channel queue diagnostic seam changed')
  }
  expect(queue.evidence()).toEqual({ queuedBytes: 0, queuedFrames: 0, storageSlots: 0 })
}

describe('mobile E2EE v2 physical channel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends hello/auth and confirms the exact transcript', async () => {
    const ctx = setup(async () => null)
    await authenticate(ctx)

    const hello = ctx.sent[0]
    const auth = ctx.sent[1]
    if (typeof hello !== 'string' || typeof auth !== 'string') {
      throw new Error('Expected hello and encrypted auth text frames')
    }
    expect(JSON.parse(hello)).toEqual(ctx.session.hello)
    const plaintext = openMobileE2EEV2Frame({
      frame: Buffer.from(auth, 'base64'),
      key: ctx.schedule.mobileToDesktopKey,
      sessionId: ctx.schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      expectedCounter: 0n
    })
    if (!plaintext) {
      throw new Error('Auth frame failed desktop decryption')
    }
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      type: 'e2ee_auth',
      v: 2,
      transcriptHashB64: '0MsOjvXsuyjwleiCNSASug/uFkz8+rYlIfG2h2p5OPk=',
      deviceToken: 'valid-token'
    })
    expect(ctx.onAuthenticated).toHaveBeenCalledOnce()
    expect(ctx.onError).not.toHaveBeenCalled()

    const wrongTranscript = setup(async () => null)
    await wrongTranscript.channel.handleMessage(JSON.stringify(wrongTranscript.ready))
    const response = serverFrame(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'e2ee_authenticated',
          v: 2,
          transcriptHashB64: 'A'.repeat(44)
        })
      ),
      'text',
      0n,
      wrongTranscript.schedule
    )
    await wrongTranscript.channel.handleMessage(Buffer.from(response).toString('base64'))
    expect(wrongTranscript.onAuthenticated).not.toHaveBeenCalled()
    expect(wrongTranscript.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Invalid E2EE v2 authenticated response' })
    )
  })

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

  it('bounds the unified outbound queue and reports a wedged link', async () => {
    const ctx = setup(async () => null)
    await authenticate(ctx)
    ctx.socket.bufferedAmount = 9 * 1024 * 1024
    const megabyte = new Uint8Array(1024 * 1024)
    for (let index = 0; index < 63; index++) {
      expect(ctx.channel.sendBinary(megabyte)).toBe(true)
    }
    expect(ctx.onError).not.toHaveBeenCalled()
    expect(ctx.sent).toHaveLength(2)
    expect(ctx.channel.sendBinary(megabyte)).toBe(true)
    expect(ctx.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'E2EE v2 outbound buffer overflow' })
    )
    ctx.socket.bufferedAmount = 0
    vi.runOnlyPendingTimers()
    expect(ctx.sent).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

class RetentionSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: (string | Uint8Array)[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  send(frame: string | Uint8Array): void {
    this.sent.push(frame)
  }

  close(): void {
    this.readyState = 3
  }

  receive(data: unknown): void {
    this.onmessage?.({ data })
  }
}

function nextInboundTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// Why: enabling the flag at runtime lets these retention checks run in every Node pool without --expose-gc.
setFlagsFromString('--expose-gc')
const collectGarbage: unknown = runInNewContext('gc')

async function collectInboundPayloads(): Promise<void> {
  if (typeof collectGarbage !== 'function') {
    throw new Error('Retention tests require V8 gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await nextInboundTurn()
    collectGarbage()
  }
}

function receiveRetainedPayload(socket: RetentionSocket): WeakRef<Uint8Array> {
  const payload = new Uint8Array(1024 * 1024)
  socket.receive(payload)
  return new WeakRef(payload)
}

describe('relay inbound payload disposal', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['link', 'close'],
    ['link', 'failure'],
    ['pairing', 'close'],
    ['pairing', 'failure']
  ] as const)(
    'releases queued %s payloads on %s while conversion is blocked',
    async (owner, mode) => {
      const ctx = setup(async () => null)
      const socket = new RetentionSocket()
      const relay = {
        v: 1 as const,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
        inviteExpiresAt: Date.now() + 300_000,
        e2eeFraming: 2 as const
      }
      const createSession = vi
        .spyOn(MobileE2EEV2ClientSession, 'create')
        .mockReturnValueOnce(ctx.session)
      const createSocket = (): WebSocket => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Both real transports only send/close and assign event handlers on this socket.
        return socket as unknown as WebSocket
      }
      const onAuthenticated = vi.fn()
      const transport =
        owner === 'link'
          ? new MobileRelayE2eeLink({
              endpoint: relay,
              credential: relay.inviteToken,
              expectedCredentialKind: 'invite',
              deviceToken: 'valid-token',
              desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
              onAuthenticated,
              onText: vi.fn(),
              onBinary: vi.fn(),
              onError: vi.fn(),
              createSocket
            })
          : connectMobileRelayForPairing({
              relay,
              deviceToken: 'valid-token',
              desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
              createSocket
            })
      createSession.mockRestore()
      socket.onopen?.()
      socket.receive(
        JSON.stringify({
          type: 'relay-hello',
          ok: true,
          credentialKind: 'invite',
          leaseExpiresAt: Date.now() + 60_000
        })
      )
      await nextInboundTurn()
      socket.receive(JSON.stringify(ctx.ready))
      await nextInboundTurn()
      const authenticated = serverFrame(
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
      socket.receive(Buffer.from(authenticated).toString('base64'))
      await nextInboundTurn()
      if (transport instanceof MobileRelayE2eeLink) {
        expect(onAuthenticated).toHaveBeenCalledOnce()
      } else {
        const reply = transport.sendRequest('status.get')
        await nextInboundTurn()
        const response = serverFrame(
          new TextEncoder().encode(
            JSON.stringify({
              id: 'relay-pair-1',
              ok: true,
              result: { path: 'relay' },
              _meta: { runtimeId: 'retention' }
            })
          ),
          'text',
          1n,
          ctx.schedule
        )
        socket.receive(Buffer.from(response).toString('base64'))
        await expect(reply).resolves.toMatchObject({ ok: true, result: { path: 'relay' } })
      }
      // A frame already admitted to this encrypted session cannot migrate to its successor.
      const sendText = (text: string) =>
        transport instanceof MobileRelayE2eeLink
          ? transport.sendText(text)
          : transport.sendRequest('github.updateIssue', { body: text })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      socket.bufferedAmount = 9 * 1024 * 1024
      const beforeParked = socket.sent.length
      const parked = sendText('old-resource')
      const settledParked = Promise.resolve(parked).catch(() => undefined)
      await Promise.resolve()
      expect(socket.sent).toHaveLength(beforeParked)
      let release = (_buffer: ArrayBuffer): void => {}
      const blocked = new Promise<ArrayBuffer>((resolve) => {
        release = resolve
      })
      socket.receive({ arrayBuffer: () => blocked })
      await nextInboundTurn()
      const refs = Array.from({ length: 8 }, () => receiveRetainedPayload(socket))
      try {
        await collectInboundPayloads()
        expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(8)
        if (mode === 'close') {
          transport.close()
        } else {
          socket.onclose?.({ code: 1006 })
        }
        socket.bufferedAmount = 0
        vi.runOnlyPendingTimers()
        await settledParked
        expect(socket.sent).toHaveLength(beforeParked)
        await collectInboundPayloads()
        expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
      } finally {
        release(new ArrayBuffer(0))
        await nextInboundTurn()
        transport.close()
        vi.useRealTimers()
      }
    }
  )
})

describe('direct v2 original-socket queue ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  it.each(['close', 'failure', 'live'] as const)(
    'a guarded admitted frame handles %s without draining onto a successor',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      const timerBaseline = vi.getTimerCount()
      let phase = 'setup'
      const timerCreations: { phase: string; delay: number | undefined; stack: string }[] = []
      const scheduleTimeout = globalThis.setTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
        timerCreations.push({
          phase,
          delay,
          stack: sanitizeCrashReportString(
            new Error('Physical channel timer creation').stack ?? '',
            2000
          )
        })
        return scheduleTimeout(callback, delay, ...args)
      })
      const scheduleInterval = globalThis.setInterval
      vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
        timerCreations.push({
          phase,
          delay,
          stack: sanitizeCrashReportString(new Error('interval').stack ?? '', 2000)
        })
        return scheduleInterval(callback, delay, ...args)
      })
      const disposed = vi.spyOn(MobileE2EEV2PhysicalChannel.prototype, 'dispose')
      const sockets: RetentionSocket[] = []
      class DirectSocket extends RetentionSocket {
        static OPEN = 1
        static CONNECTING = 0
        constructor() {
          super()
          sockets.push(this)
        }
      }
      vi.stubGlobal('WebSocket', DirectSocket)
      let auxiliary: ReturnType<typeof setup> | undefined
      let actualClient: ReturnType<typeof connect> | undefined
      let requestSettled = false
      let outcome: Promise<unknown> | undefined
      let firstFailure: { error: unknown } | undefined
      const cleanupFailures: unknown[] = []
      try {
        const ctx = setup(async () => null, 'direct')
        auxiliary = ctx
        vi.spyOn(MobileE2EEV2ClientSession, 'create').mockReturnValueOnce(ctx.session)
        const client = connect(
          'ws://desktop.invalid',
          'valid-token',
          Buffer.from(desktop.publicKey).toString('base64')
        )
        actualClient = client
        const socket = sockets[0]
        phase = 'handshake'
        socket.onopen?.()
        socket.receive(JSON.stringify(ctx.ready))
        await nextInboundTurn()
        socket.receive(
          Buffer.from(
            serverFrame(
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
          ).toString('base64')
        )
        await nextInboundTurn()
        expect(client.getState()).toBe('connected')
        socket.bufferedAmount = 9 * 1024 * 1024
        const before = socket.sent.length
        phase = 'request'
        const pending = client.sendRequest(
          'github.updateIssue',
          {
            ownerRepo: { owner: 'fork', repo: 'widgets' },
            number: 93,
            updates: { state: 'closed' }
          },
          {
            beforeSend: () => {
              expect(client.getState()).toBe('connected')
            }
          }
        )
        outcome = pending.then(
          (reply) => {
            requestSettled = true
            return reply
          },
          (error: unknown) => {
            requestSettled = true
            return error
          }
        )
        await nextInboundTurn()
        expect(socket.sent).toHaveLength(before)
        if (mode === 'close') {
          client.close()
        }
        if (mode === 'failure') {
          socket.readyState = 3
          socket.onclose?.({ code: 1006 })
        }
        phase = 'drain'
        socket.bufferedAmount = 0
        await vi.advanceTimersByTimeAsync(25)
        if (mode === 'live') {
          expect(socket.sent).toHaveLength(before + 1)
          const raw = socket.sent.at(-1)
          if (typeof raw !== 'string') {
            throw new Error('expected text request')
          }
          const request = JSON.parse(
            new TextDecoder().decode(
              openMobileE2EEV2Frame({
                frame: Buffer.from(raw, 'base64'),
                key: ctx.schedule.mobileToDesktopKey,
                sessionId: ctx.schedule.sessionId,
                direction: 'mobile-to-desktop',
                payloadKind: 'text',
                expectedCounter: 1n
              })!
            )
          )
          expect(request).toMatchObject({
            method: 'github.updateIssue',
            params: { ownerRepo: { owner: 'fork' } }
          })
          socket.receive(
            Buffer.from(
              serverFrame(
                new TextEncoder().encode(
                  JSON.stringify({ id: request.id, ok: true, result: { ok: true } })
                ),
                'text',
                1n,
                ctx.schedule
              )
            ).toString('base64')
          )
          await nextInboundTurn()
          await expect(pending).resolves.toMatchObject({ ok: true })
        } else {
          expect(socket.sent).toHaveLength(before)
          expect(await outcome).toBeInstanceOf(Error)
          expect(sockets).toHaveLength(1)
        }
      } catch (error) {
        firstFailure = { error }
      } finally {
        phase = 'cleanup'
        for (const release of [() => actualClient?.close(), () => auxiliary?.channel.dispose()]) {
          try {
            release()
          } catch (error) {
            cleanupFailures.push(error)
          }
        }
        try {
          // rejectAll queues rejection; let the actual tracker and inbound disposal finish without moving deadlines.
          await Promise.resolve()
          await nextInboundTurn()
          if (outcome) {
            expect(requestSettled).toBe(true)
          }
          if (auxiliary) {
            expect(disposed.mock.contexts).toContain(auxiliary.channel)
          }
          expect(new Set(disposed.mock.contexts).size).toBe(
            Number(Boolean(auxiliary)) + Number(Boolean(actualClient))
          )
          for (const channel of new Set(disposed.mock.contexts)) {
            assertReleasedPhysicalChannel(channel)
          }
          expect(vi.getTimerCount(), JSON.stringify({ mode, phase, timerCreations })).toBe(
            timerBaseline
          )
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
      if (firstFailure && cleanupFailures.length === 0) {
        throw firstFailure.error
      }
      if (cleanupFailures.length) {
        throw new AggregateError(
          [...(firstFailure ? [firstFailure.error] : []), ...cleanupFailures],
          `direct ${mode}: ${firstFailure ? 'body failed; cleanup evidence follows' : 'cleanup failed'}`,
          firstFailure ? { cause: firstFailure.error } : undefined
        )
      }
    }
  )
})
