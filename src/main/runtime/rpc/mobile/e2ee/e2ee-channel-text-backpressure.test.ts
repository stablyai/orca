import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { RpcBinarySendResult } from '../../transports/rpc-binary-sender'
import { E2EEChannel, type E2EEChannelOptions } from './e2ee-channel'
import {
  deriveSharedKey,
  decrypt,
  decryptBytes,
  encrypt,
  generateKeyPair
} from '../../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { createMobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))

// Legacy terminal.subscribe has no seq/resync: congestion must queue text and binary replies in order, never drop them.

function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

function createMockWs() {
  const sent: (string | Buffer)[] = []
  return {
    OPEN: 1 as const,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: string | Buffer) => {
      sent.push(data)
    }),
    close: vi.fn(),
    sent
  }
}

function setup(overrides?: Partial<E2EEChannelOptions>) {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const ws = createMockWs()
  const onError = vi.fn()
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: serverKeys.secretKey,
    resolveAuthenticatedDevice: (token) =>
      token === 'valid-token'
        ? {
            deviceId: 'device-1',
            deviceToken: token,
            scope: 'mobile',
            clientId: token,
            callerFingerprint: 'test-fingerprint',
            credentialRevision: 0
          }
        : null,
    onReady: vi.fn(),
    onError,
    ...overrides
  })
  const sharedKey = deriveSharedKey(clientKeys.secretKey, serverKeys.publicKey)
  channel.handleRawMessage(
    JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(clientKeys.publicKey) })
  )
  channel.handleRawMessage(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), sharedKey)
  )
  return { channel, ws, sharedKey, onError }
}

function emitReply(ctx: ReturnType<typeof setup>, payload: string): void {
  ctx.channel.onMessage((_plaintext, encryptedReply) => {
    encryptedReply(payload)
  })
  ctx.channel.handleRawMessage(encrypt('{"id":"x","method":"status.get"}', ctx.sharedKey))
}

describe('E2EE text reply backpressure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    trackMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects aggregate queue growth across independently backpressured sockets', () => {
    const outboundMemoryBudget = createMobileE2EEOutboundMemoryBudget({
      maxBufferedBytes: 1_000,
      maxQueuedBytes: 150,
      maxQueuedFrames: 10
    })
    const first = setup({ outboundMemoryBudget })
    const second = setup({ outboundMemoryBudget })
    first.ws.bufferedAmount = 1_001
    second.ws.bufferedAmount = 1_001

    emitReply(first, 'x'.repeat(40))
    emitReply(second, 'x'.repeat(40))

    expect(first.onError).not.toHaveBeenCalled()
    expect(second.onError).toHaveBeenCalledWith(1013, 'Outbound reply buffer overflow')
    expect(trackMock).toHaveBeenCalledWith('remote_outbound_budget_close', {
      emitter: 'queue'
    })
    first.channel.destroy()
    expect(outboundMemoryBudget.evidence().queuedBytes).toBe(0)
  })
})

describe('E2EE legacy binary reply backpressure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    trackMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function decodeSent(ctx: ReturnType<typeof setup>, frame: string | Buffer): string {
    return typeof frame === 'string'
      ? decrypt(frame, ctx.sharedKey)!
      : `binary:${Buffer.from(decryptBytes(new Uint8Array(frame), ctx.sharedKey)!).toString()}`
  }

  // Legacy binary terminal frames lack gap detection; loss or reordering corrupts the phone screen.
  it('holds binary replies in one order with text while the outbound budget is full', () => {
    const outboundMemoryBudget = createMobileE2EEOutboundMemoryBudget({ maxBufferedBytes: 1_000 })
    const ctx = setup({ outboundMemoryBudget })
    const baseline = ctx.ws.sent.length
    ctx.ws.bufferedAmount = 1_001
    const accepted: RpcBinarySendResult[] = []

    ctx.channel.onMessage((_plaintext, encryptedReply, encryptedBinaryReply) => {
      encryptedReply('{"seq":1}')
      accepted.push(encryptedBinaryReply(Buffer.from('2')))
      encryptedReply('{"seq":3}')
      accepted.push(encryptedBinaryReply(Buffer.from('4')))
    })
    ctx.channel.handleRawMessage(encrypt('{"id":"x","method":"terminal.subscribe"}', ctx.sharedKey))
    expect(ctx.ws.sent.length).toBe(baseline)

    ctx.ws.bufferedAmount = 0
    vi.runOnlyPendingTimers()

    expect(accepted).toEqual([true, true])
    expect(ctx.ws.sent.slice(baseline).map((frame) => decodeSent(ctx, frame))).toEqual([
      '{"seq":1}',
      'binary:2',
      '{"seq":3}',
      'binary:4'
    ])
    expect(ctx.onError).not.toHaveBeenCalled()
  })
})
