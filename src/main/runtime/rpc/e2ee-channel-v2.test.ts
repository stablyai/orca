import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Hello,
  type MobileE2EEV2Ready
} from '../../../shared/mobile-e2ee-v2-contract'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../shared/mobile-e2ee-v2-framing'
import { deriveSharedKey } from './e2ee-crypto'
import { E2EEChannel } from './e2ee-channel'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'

const server = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))

function createMockWs() {
  const sent: { data: string | Buffer; options?: { binary?: boolean } }[] = []
  return {
    OPEN: 1 as const,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: string | Buffer, options?: { binary?: boolean }) => {
      sent.push({ data, options })
    }),
    sent
  }
}

function hello(): MobileE2EEV2Hello {
  return {
    type: 'e2ee_hello',
    v: 2,
    clientPublicKeyB64: Buffer.from(client.publicKey).toString('base64'),
    clientNonceB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
    capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
    context: {
      protocol: 'orca-mobile-e2ee',
      initiator: 'mobile',
      responder: 'desktop',
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9'
    }
  }
}

function setup() {
  const ws = createMockWs()
  const onReady = vi.fn()
  const onError = vi.fn()
  const resolveAuthenticatedDevice = vi.fn((token: string) =>
    token === 'valid-token'
      ? { deviceId: 'device-1', deviceToken: token, scope: 'mobile' as const }
      : null
  )
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: server.secretKey,
    resolveAuthenticatedDevice,
    onReady,
    onError,
    transportContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
    requireV2: true
  })
  return { ws, channel, onReady, onError, resolveAuthenticatedDevice }
}

function startV2(ctx: ReturnType<typeof setup>) {
  const clientHello = hello()
  ctx.channel.handleRawMessage(JSON.stringify(clientHello))
  const ready = JSON.parse(ctx.ws.sent[0]!.data.toString()) as MobileE2EEV2Ready
  const handshake = validateMobileE2EEV2Handshake(clientHello, ready)!
  const schedule = deriveMobileE2EEV2KeySchedule({
    sharedSecret: deriveSharedKey(client.secretKey, server.publicKey),
    transcript: encodeMobileE2EEV2Transcript(handshake),
    clientNonce: handshake.clientNonce,
    desktopNonce: handshake.desktopNonce
  })
  return { ready, schedule }
}

function clientText(
  plaintext: string,
  schedule: ReturnType<typeof startV2>['schedule'],
  counter: bigint
): string {
  const frame = sealMobileE2EEV2Frame({
    payload: new TextEncoder().encode(plaintext),
    key: schedule.mobileToDesktopKey,
    sessionId: schedule.sessionId,
    direction: 'mobile-to-desktop',
    payloadKind: 'text',
    counter
  })
  return Buffer.from(frame).toString('base64')
}

function openServerFrame(
  frame: string | Buffer,
  kind: 'text' | 'binary',
  schedule: ReturnType<typeof startV2>['schedule'],
  counter: bigint
): Uint8Array | null {
  return openMobileE2EEV2Frame({
    frame: typeof frame === 'string' ? Buffer.from(frame, 'base64') : frame,
    key: schedule.desktopToMobileKey,
    sessionId: schedule.sessionId,
    direction: 'desktop-to-mobile',
    payloadKind: kind,
    expectedCounter: counter
  })
}

function authenticate(
  ctx: ReturnType<typeof setup>,
  schedule: ReturnType<typeof startV2>['schedule']
) {
  const transcriptHashB64 = Buffer.from(schedule.transcriptHash).toString('base64')
  ctx.channel.handleRawMessage(
    clientText(
      JSON.stringify({
        type: 'e2ee_auth',
        v: 2,
        transcriptHashB64,
        deviceToken: 'valid-token'
      }),
      schedule,
      0n
    )
  )
}

describe('E2EEChannel v2', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('confirms the transcript before evaluating DeviceRegistry auth', () => {
    const ctx = setup()
    const { schedule } = startV2(ctx)
    authenticate(ctx, schedule)

    expect(ctx.resolveAuthenticatedDevice).toHaveBeenCalledOnce()
    expect(ctx.onReady).toHaveBeenCalledWith(ctx.channel, {
      deviceId: 'device-1',
      deviceToken: 'valid-token',
      scope: 'mobile'
    })
    const authenticated = openServerFrame(ctx.ws.sent[1]!.data, 'text', schedule, 0n)
    expect(JSON.parse(new TextDecoder().decode(authenticated!))).toEqual({
      type: 'e2ee_authenticated',
      v: 2,
      transcriptHashB64: Buffer.from(schedule.transcriptHash).toString('base64')
    })
  })

  it('rejects legacy downgrade and injected auth metadata when v2 is required', () => {
    const legacy = setup()
    legacy.channel.handleRawMessage(
      JSON.stringify({ type: 'e2ee_hello', publicKeyB64: 'legacy-key' })
    )
    expect(legacy.onError).toHaveBeenCalledWith(4001, 'E2EE v2 required')

    const ctx = setup()
    const { schedule } = startV2(ctx)
    const transcriptHashB64 = Buffer.from(schedule.transcriptHash).toString('base64')
    ctx.channel.handleRawMessage(
      clientText(
        JSON.stringify({
          type: 'e2ee_auth',
          v: 2,
          transcriptHashB64,
          deviceToken: 'valid-token',
          relayDeviceId: 'injected'
        }),
        schedule,
        0n
      )
    )
    expect(ctx.resolveAuthenticatedDevice).not.toHaveBeenCalled()
  })

  it('rejects a captured auth frame replayed onto a fresh desktop nonce', () => {
    const first = setup()
    const firstHandshake = startV2(first)
    const capturedAuth = clientText(
      JSON.stringify({
        type: 'e2ee_auth',
        v: 2,
        transcriptHashB64: Buffer.from(firstHandshake.schedule.transcriptHash).toString('base64'),
        deviceToken: 'valid-token'
      }),
      firstHandshake.schedule,
      0n
    )

    const second = setup()
    const secondHandshake = startV2(second)
    expect(secondHandshake.ready.desktopNonceB64).not.toBe(firstHandshake.ready.desktopNonceB64)
    second.channel.handleRawMessage(capturedAuth)
    expect(second.resolveAuthenticatedDevice).not.toHaveBeenCalled()
    expect(second.onReady).not.toHaveBeenCalled()
  })

  it('rejects a captured authenticated mutating trace on a fresh socket', () => {
    const first = setup()
    const firstHandshake = startV2(first)
    const transcriptHashB64 = Buffer.from(firstHandshake.schedule.transcriptHash).toString('base64')
    const capturedAuth = clientText(
      JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, deviceToken: 'valid-token' }),
      firstHandshake.schedule,
      0n
    )
    const capturedMutation = clientText(
      JSON.stringify({ method: 'device.remove', params: { deviceId: 'device-1' } }),
      firstHandshake.schedule,
      1n
    )
    const firstMutation = vi.fn()
    first.channel.onMessage(firstMutation)
    first.channel.handleRawMessage(capturedAuth)
    first.channel.handleRawMessage(capturedMutation)
    expect(firstMutation).toHaveBeenCalledOnce()

    const second = setup()
    startV2(second)
    const replayedMutation = vi.fn()
    second.channel.onMessage(replayedMutation)
    second.channel.handleRawMessage(capturedAuth)
    second.channel.handleRawMessage(capturedMutation)
    expect(second.resolveAuthenticatedDevice).not.toHaveBeenCalled()
    expect(replayedMutation).not.toHaveBeenCalled()
  })

  it('preserves one queued counter order across text and binary replies', () => {
    const ctx = setup()
    const { schedule } = startV2(ctx)
    authenticate(ctx, schedule)
    ctx.ws.bufferedAmount = 9 * 1024 * 1024
    ctx.channel.onMessage((_request, textReply, binaryReply) => {
      textReply('one')
      binaryReply(new Uint8Array([2]))
    })
    ctx.channel.handleRawMessage(clientText('{"method":"status.get"}', schedule, 1n))
    expect(ctx.ws.sent).toHaveLength(2)

    ctx.ws.bufferedAmount = 0
    vi.runOnlyPendingTimers()
    expect(
      new TextDecoder().decode(openServerFrame(ctx.ws.sent[2]!.data, 'text', schedule, 1n)!)
    ).toBe('one')
    expect(openServerFrame(ctx.ws.sent[3]!.data, 'binary', schedule, 2n)).toEqual(
      new Uint8Array([2])
    )
    expect(ctx.ws.sent[3]!.options).toEqual({ binary: true })
  })
})
