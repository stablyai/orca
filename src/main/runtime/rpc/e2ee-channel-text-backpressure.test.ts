import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { RpcBinarySendResult } from './rpc-binary-sender'
import { E2EEChannel, type E2EEChannelOptions } from './e2ee-channel'
import { deriveSharedKey, decrypt, decryptBytes, encrypt, generateKeyPair } from './e2ee-crypto'
import { createMobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('../../telemetry/client', () => ({ track: trackMock }))

// Repro for gap (a): the streaming JSON reply path (encryptedReply) had no
// bufferedAmount gate, so a fast producer over a slow link (legacy
// terminal.subscribe, which has NO seq/resync) ballooned ws.bufferedAmount
// without bound. The fix holds replies in order and drains on recovery — never
// dropping a frame (which would recreate the corruption bug on the legacy path).

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
        ? { deviceId: 'device-1', deviceToken: token, scope: 'mobile' }
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

/** Fire a streaming reply through the real channel's encryptedReply closure. */
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

  it('holds text replies while over the buffer cap and drains them in order', () => {
    const ctx = setup()
    const baseline = ctx.ws.sent.length // ready + authenticated control frames

    // Simulate a congested socket: bufferedAmount pinned over the 8 MiB cap.
    ctx.ws.bufferedAmount = 9 * 1024 * 1024

    emitReply(ctx, '{"seq":1}')
    emitReply(ctx, '{"seq":2}')
    emitReply(ctx, '{"seq":3}')

    // Not dropped, not sent yet — parked in order on the queue.
    expect(ctx.ws.sent.length).toBe(baseline)

    // Link drains; the queue flushes every reply, in order, none lost.
    ctx.ws.bufferedAmount = 0
    vi.runOnlyPendingTimers()

    const replies = ctx.ws.sent
      .slice(baseline)
      .map((frame) => decrypt(String(frame), ctx.sharedKey))
    expect(replies).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}'])
    expect(ctx.onError).not.toHaveBeenCalled()
  })

  it('sends straight through when the socket is not congested', () => {
    const ctx = setup()
    const baseline = ctx.ws.sent.length
    emitReply(ctx, '{"ok":true}')
    expect(ctx.ws.sent.length).toBe(baseline + 1)
    expect(decrypt(String(ctx.ws.sent[baseline]), ctx.sharedKey)).toBe('{"ok":true}')
  })

  it('still closes an oversized reply when telemetry throws', () => {
    const ctx = setup()
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry unavailable')
    })

    expect(() =>
      emitReply(ctx, 'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES + 1))
    ).not.toThrow()
    expect(trackMock).toHaveBeenCalledWith('remote_outbound_budget_close', { emitter: 'size' })
    expect(ctx.onError).toHaveBeenCalledWith(1013, 'Outbound reply buffer overflow')
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
    // Why: this close kills the whole remote session, so it has to be countable.
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

  // Why: legacy terminal.subscribe has no seq-gap check, so a dropped or reordered binary frame corrupts the phone's screen.
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

  it('closes for budget instead of dropping when queued binary overflows', () => {
    const outboundMemoryBudget = createMobileE2EEOutboundMemoryBudget({
      maxBufferedBytes: 1_000,
      maxQueuedBytes: 150
    })
    const ctx = setup({ outboundMemoryBudget })
    ctx.ws.bufferedAmount = 1_001

    ctx.channel.onMessage((_plaintext, _encryptedReply, encryptedBinaryReply) => {
      encryptedBinaryReply(new Uint8Array(100))
      encryptedBinaryReply(new Uint8Array(100))
    })
    ctx.channel.handleRawMessage(encrypt('{"id":"x","method":"terminal.subscribe"}', ctx.sharedKey))

    expect(ctx.onError).toHaveBeenCalledWith(1013, 'Outbound reply buffer overflow')
    expect(trackMock).toHaveBeenCalledWith('remote_outbound_budget_close', { emitter: 'queue' })
  })

  it('refuses binary once the socket has left OPEN', () => {
    const ctx = setup()
    ctx.ws.readyState = 3
    let accepted: RpcBinarySendResult = undefined

    ctx.channel.onMessage((_plaintext, _encryptedReply, encryptedBinaryReply) => {
      accepted = encryptedBinaryReply(new Uint8Array([1]))
    })
    ctx.channel.handleRawMessage(encrypt('{"id":"x","method":"terminal.subscribe"}', ctx.sharedKey))

    expect(accepted).toBe(false)
  })

  it('drops a backlogged lossy binary reply instead of queueing it, then sends once drained', () => {
    const ctx = setup()
    const baseline = ctx.ws.sent.length
    ctx.ws.bufferedAmount = 9 * 1024 * 1024
    const accepted: RpcBinarySendResult[] = []
    ctx.channel.onMessage((_plaintext, _encryptedReply, encryptedBinaryReply) => {
      accepted.push(encryptedBinaryReply(Buffer.from('frame'), { dropWhenBacklogged: true }))
    })
    const request = encrypt('{"id":"x","method":"browser.screencast"}', ctx.sharedKey)
    ctx.channel.handleRawMessage(request)
    ctx.ws.bufferedAmount = 0
    vi.runOnlyPendingTimers()
    expect(ctx.ws.sent.length).toBe(baseline)

    ctx.channel.handleRawMessage(request)
    expect(accepted).toEqual(['backlogged', true])
    expect(ctx.ws.sent.slice(baseline).map((frame) => decodeSent(ctx, frame))).toEqual([
      'binary:frame'
    ])
    expect(ctx.onError).not.toHaveBeenCalled()
  })
})
