import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import { E2EEChannel } from './e2ee-channel'
import { generateKeyPair, deriveSharedKey, encrypt, decrypt } from '../../../shared/e2ee-crypto'

// Exercise mobile/desktop ephemeral key exchange and encrypted RPC compatibility without a real WebSocket.

function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

describe('E2EE integration (simulated mobile ↔ desktop)', () => {
  let serverKeys: ReturnType<typeof generateKeyPair>
  let mobileEphemeralKeys: ReturnType<typeof generateKeyPair>
  let wsSent: string[]
  let mockWs: {
    OPEN: 1
    readyState: number
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  let channel: E2EEChannel
  let onReady: (channel: E2EEChannel) => void
  let onError: (code: number, reason: string) => void

  beforeEach(() => {
    vi.useFakeTimers()

    serverKeys = generateKeyPair()
    mobileEphemeralKeys = generateKeyPair()
    wsSent = []
    mockWs = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((data: string) => wsSent.push(data)),
      close: vi.fn()
    }
    onReady = vi.fn() as unknown as (channel: E2EEChannel) => void
    onError = vi.fn() as unknown as (code: number, reason: string) => void

    channel = new E2EEChannel(mockWs as unknown as WebSocket, {
      serverSecretKey: serverKeys.secretKey,
      resolveAuthenticatedDevice: (token) =>
        token === 'device-abc'
          ? {
              deviceId: 'device-abc',
              deviceToken: token,
              scope: 'mobile',
              clientId: token,
              callerFingerprint: 'test-fingerprint',
              credentialRevision: 0
            }
          : null,
      onReady,
      onError
    })
  })

  afterEach(() => {
    channel.destroy()
    vi.useRealTimers()
  })

  function completeHandshake(targetChannel = channel, keys = mobileEphemeralKeys): Uint8Array {
    targetChannel.handleRawMessage(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(keys.publicKey)
      })
    )
    const sharedKey = deriveSharedKey(keys.secretKey, serverKeys.publicKey)
    targetChannel.handleRawMessage(
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'device-abc' }), sharedKey)
    )
    return sharedKey
  }

  it('full handshake → encrypted RPC round-trip', () => {
    const mobileShared = completeHandshake()

    // Handshake returns plaintext ready followed by an encrypted auth acknowledgement.
    expect(onReady).toHaveBeenCalled()
    expect(wsSent).toHaveLength(2)
    expect(JSON.parse(wsSent[0]!)).toEqual({ type: 'e2ee_ready' })
    expect(JSON.parse(decrypt(wsSent[1]!, mobileShared)!)).toEqual({
      type: 'e2ee_authenticated'
    })

    const desktopReceived: string[] = []
    channel.onMessage((plaintext, encryptedReply) => {
      desktopReceived.push(plaintext)
      encryptedReply(JSON.stringify({ id: 'rpc-1', ok: true, result: { status: 'ready' } }))
    })

    const request = JSON.stringify({ id: 'rpc-1', method: 'status.get' })
    channel.handleRawMessage(encrypt(request, mobileShared))

    expect(desktopReceived).toEqual([request])

    expect(wsSent).toHaveLength(3)
    const replyPlain = decrypt(wsSent[2]!, mobileShared)
    expect(JSON.parse(replyPlain!)).toEqual({
      id: 'rpc-1',
      ok: true,
      result: { status: 'ready' }
    })
  })

  it('mobile reconnects with fresh ephemeral key', () => {
    completeHandshake()
    expect(onReady).toHaveBeenCalledTimes(1)

    const firstShared = deriveSharedKey(mobileEphemeralKeys.secretKey, serverKeys.publicKey)

    channel.destroy()
    wsSent.length = 0

    const newMobileKeys = generateKeyPair()
    const newChannel = new E2EEChannel(mockWs as unknown as WebSocket, {
      serverSecretKey: serverKeys.secretKey,
      resolveAuthenticatedDevice: (token) =>
        token === 'device-abc'
          ? {
              deviceId: 'device-abc',
              deviceToken: token,
              scope: 'mobile',
              clientId: token,
              callerFingerprint: 'test-fingerprint',
              credentialRevision: 0
            }
          : null,
      onReady,
      onError
    })

    completeHandshake(newChannel, newMobileKeys)

    expect(onReady).toHaveBeenCalledTimes(2)

    const secondShared = deriveSharedKey(newMobileKeys.secretKey, serverKeys.publicKey)

    expect(Buffer.from(firstShared).toString('hex')).not.toBe(
      Buffer.from(secondShared).toString('hex')
    )

    const received: string[] = []
    newChannel.onMessage((plaintext) => received.push(plaintext))
    newChannel.handleRawMessage(encrypt('{"id":"2","method":"test"}', secondShared))
    expect(received).toEqual(['{"id":"2","method":"test"}'])

    newChannel.destroy()
  })
})
