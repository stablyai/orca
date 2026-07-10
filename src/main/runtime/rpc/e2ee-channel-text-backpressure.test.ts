import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { E2EEChannel, type E2EEChannelOptions } from './e2ee-channel'
import { deriveSharedKey, decrypt, encrypt, generateKeyPair } from './e2ee-crypto'

// Repro for gap (a): the streaming JSON reply path (encryptedReply) had no
// bufferedAmount gate, so a fast producer over a slow link (legacy
// terminal.subscribe, which has NO seq/resync) ballooned ws.bufferedAmount
// without bound. The fix holds replies in order and drains on recovery — never
// dropping a frame (which would recreate the corruption bug on the legacy path).

function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

function createMockWs() {
  const sent: string[] = []
  return {
    OPEN: 1 as const,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: string) => {
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
    validateToken: (token) => token === 'valid-token',
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

    const replies = ctx.ws.sent.slice(baseline).map((frame) => decrypt(frame, ctx.sharedKey))
    expect(replies).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}'])
    expect(ctx.onError).not.toHaveBeenCalled()
  })

  it('sends straight through when the socket is not congested', () => {
    const ctx = setup()
    const baseline = ctx.ws.sent.length
    emitReply(ctx, '{"ok":true}')
    expect(ctx.ws.sent.length).toBe(baseline + 1)
    expect(decrypt(ctx.ws.sent[baseline]!, ctx.sharedKey)).toBe('{"ok":true}')
  })
})
