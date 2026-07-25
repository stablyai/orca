import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import { E2EEChannel, type E2EEChannelOptions } from './e2ee-channel'
import { generateKeyPair, deriveSharedKey, encrypt, decrypt, encryptBytes } from './e2ee-crypto'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
} from '../../../shared/remote-runtime-memory-limits'
import { REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS } from '../../../shared/remote-runtime-request-frames'

function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

function createMockWs() {
  const sent: string[] = []
  return {
    OPEN: 1 as const,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    sent
  }
}

function setup(overrides?: Partial<E2EEChannelOptions>) {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const ws = createMockWs()
  const onReady = vi.fn()
  const onError = vi.fn()

  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: serverKeys.secretKey,
    resolveAuthenticatedDevice: (token) =>
      token === 'valid-token'
        ? { deviceId: 'device-1', deviceToken: token, scope: 'mobile' }
        : null,
    onReady,
    onError,
    ...overrides
  })

  return { channel, ws, serverKeys, clientKeys, onReady, onError }
}

function doHandshake(ctx: ReturnType<typeof setup>) {
  const hello = JSON.stringify({
    type: 'e2ee_hello',
    publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey)
  })
  ctx.channel.handleRawMessage(hello)
  const sharedKey = deriveSharedKey(ctx.clientKeys.secretKey, ctx.serverKeys.publicKey)
  ctx.channel.handleRawMessage(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), sharedKey)
  )
  return sharedKey
}

describe('E2EEChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('handshake', () => {
    it('completes handshake with valid encrypted auth', () => {
      const ctx = setup()
      doHandshake(ctx)

      expect(ctx.onReady).toHaveBeenCalledWith(ctx.channel, {
        deviceId: 'device-1',
        deviceToken: 'valid-token',
        scope: 'mobile'
      })
      expect(ctx.onError).not.toHaveBeenCalled()
      expect(ctx.channel.deviceToken).toBe('valid-token')

      const readyMsg = JSON.parse(ctx.ws.sent[0]!)
      expect(readyMsg).toEqual({ type: 'e2ee_ready' })
      const authMsg = decrypt(
        ctx.ws.sent[1]!,
        deriveSharedKey(ctx.clientKeys.secretKey, ctx.serverKeys.publicKey)
      )
      expect(JSON.parse(authMsg!)).toEqual({ type: 'e2ee_authenticated' })
    })

    it('does not authenticate from plaintext hello alone', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey)
        })
      )

      expect(ctx.onReady).not.toHaveBeenCalled()
      expect(JSON.parse(ctx.ws.sent[0]!)).toEqual({ type: 'e2ee_ready' })
    })

    it('rejects invalid encrypted token', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey)
        })
      )
      const sharedKey = deriveSharedKey(ctx.clientKeys.secretKey, ctx.serverKeys.publicKey)
      ctx.channel.handleRawMessage(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'bad-token' }), sharedKey)
      )

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Unauthorized')
      expect(ctx.onReady).not.toHaveBeenCalled()
    })

    it('rejects an auth frame encrypted to a stale desktop key', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey)
        })
      )
      const staleServer = generateKeyPair()
      const staleSharedKey = deriveSharedKey(ctx.clientKeys.secretKey, staleServer.publicKey)

      ctx.channel.handleRawMessage(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), staleSharedKey)
      )

      expect(ctx.onError).toHaveBeenCalledOnce()
      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Unauthorized')
      expect(ctx.onReady).not.toHaveBeenCalled()
    })

    it('rejects malformed JSON', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage('not json')

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid handshake message')
    })

    it('rejects structurally amplified hello JSON before parsing', () => {
      const ctx = setup()
      const amplified = `{"type":"e2ee_hello","padding":[${'0,'.repeat(REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS.structuralTokens)}0]}`
      const parse = vi.spyOn(JSON, 'parse')

      ctx.channel.handleRawMessage(amplified)

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid handshake message')
      expect(parse).not.toHaveBeenCalled()
      parse.mockRestore()
      ctx.channel.destroy()
    })

    it('rejects structurally amplified auth JSON before parsing', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey)
        })
      )
      const sharedKey = deriveSharedKey(ctx.clientKeys.secretKey, ctx.serverKeys.publicKey)
      const amplified = `{"type":"e2ee_auth","deviceToken":"valid-token","padding":[${'0,'.repeat(REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS.structuralTokens)}0]}`
      const parse = vi.spyOn(JSON, 'parse')

      ctx.channel.handleRawMessage(encrypt(amplified, sharedKey))

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid e2ee_auth')
      expect(parse).not.toHaveBeenCalled()
      parse.mockRestore()
      ctx.channel.destroy()
    })

    it('rejects missing fields', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(JSON.stringify({ type: 'e2ee_hello' }))

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid e2ee_hello')
    })

    it('rejects invalid public key length', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from('short').toString('base64')
        })
      )

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid public key')
    })

    it('rejects oversized public key text before base64 decoding', () => {
      const ctx = setup()
      const decode = vi.spyOn(Buffer, 'from')

      ctx.channel.handleRawMessage(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: 'A'.repeat(45) })
      )

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid public key')
      expect(decode).not.toHaveBeenCalled()
      decode.mockRestore()
    })

    it('times out if no hello received', () => {
      const ctx = setup()

      vi.advanceTimersByTime(10_001)

      expect(ctx.onError).toHaveBeenCalledWith(4002, 'E2EE handshake timeout')
    })

    it('clears timeout after successful handshake', () => {
      const ctx = setup()
      doHandshake(ctx)

      vi.advanceTimersByTime(10_001)

      expect(ctx.onError).not.toHaveBeenCalled()
    })
  })

  describe('post-handshake messaging', () => {
    it('decrypts and forwards messages', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const received: string[] = []

      ctx.channel.onMessage((plaintext) => {
        received.push(plaintext)
      })

      const request = '{"id":"rpc-1","method":"status.get"}'
      ctx.channel.handleRawMessage(encrypt(request, sharedKey))

      expect(received).toEqual([request])
    })

    it('provides encrypted reply function', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)

      ctx.channel.onMessage((_plaintext, encryptedReply) => {
        encryptedReply('{"id":"rpc-1","ok":true}')
      })

      ctx.channel.handleRawMessage(encrypt('{"id":"rpc-1","method":"status.get"}', sharedKey))

      // The reply (ws.sent[2], after ready + authenticated) should be encrypted
      const replyEncrypted = ctx.ws.sent[2]!
      const replyPlain = decrypt(replyEncrypted, sharedKey)
      expect(replyPlain).toBe('{"id":"rpc-1","ok":true}')
    })

    it('rejects an oversized text reply before encryption', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const sentBefore = ctx.ws.sent.length

      ctx.channel.onMessage((_plaintext, encryptedReply) => {
        encryptedReply('x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES + 1))
      })
      ctx.channel.handleRawMessage(encrypt('request', sharedKey))

      expect(ctx.onError).toHaveBeenCalledWith(1013, 'Outbound reply buffer overflow')
      expect(ctx.ws.sent).toHaveLength(sentBefore)
    })

    it('rejects an oversized binary reply before encryption', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const sentBefore = ctx.ws.sent.length
      let accepted: boolean | void = undefined

      ctx.channel.onMessage((_plaintext, _encryptedReply, encryptedBinaryReply) => {
        accepted = encryptedBinaryReply(
          new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1)
        )
      })
      ctx.channel.handleRawMessage(encrypt('request', sharedKey))

      expect(accepted).toBe(false)
      expect(ctx.onError).toHaveBeenCalledWith(1013, 'Outbound reply buffer overflow')
      expect(ctx.ws.sent).toHaveLength(sentBefore)
    })

    it('decrypts and forwards binary messages after authentication', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const received: Uint8Array<ArrayBufferLike>[] = []

      ctx.channel.onBinaryMessage((bytes) => {
        received.push(bytes)
      })

      ctx.channel.handleRawMessage(encryptBytes(new Uint8Array([1, 2, 3]), sharedKey))

      expect([...received[0]!]).toEqual([1, 2, 3])
    })

    it('silently drops messages with wrong key', () => {
      const ctx = setup()
      doHandshake(ctx)
      const received: string[] = []

      ctx.channel.onMessage((plaintext) => {
        received.push(plaintext)
      })

      const attackerKey = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)
      ctx.channel.handleRawMessage(encrypt('attack', attackerKey))

      expect(received).toEqual([])
    })

    it('closes after too many consecutive decrypt failures', () => {
      const ctx = setup()
      doHandshake(ctx)
      ctx.channel.onMessage(() => {})

      const badKey = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)

      for (let i = 0; i < 4; i++) {
        ctx.channel.handleRawMessage(encrypt('bad', badKey))
      }
      expect(ctx.onError).not.toHaveBeenCalled()

      ctx.channel.handleRawMessage(encrypt('bad', badKey))
      expect(ctx.onError).toHaveBeenCalledWith(4003, 'Too many decryption failures')
    })

    it('resets failure count on successful decrypt', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      ctx.channel.onMessage(() => {})

      const badKey = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)

      for (let i = 0; i < 4; i++) {
        ctx.channel.handleRawMessage(encrypt('bad', badKey))
      }

      // Successful decrypt resets the counter
      ctx.channel.handleRawMessage(encrypt('good', sharedKey))

      for (let i = 0; i < 4; i++) {
        ctx.channel.handleRawMessage(encrypt('bad', badKey))
      }
      expect(ctx.onError).not.toHaveBeenCalled()
    })
  })

  describe('cross-compatibility', () => {
    it('desktop encrypt is decryptable by desktop decrypt (sanity)', () => {
      const a = generateKeyPair()
      const b = generateKeyPair()
      const sharedA = deriveSharedKey(a.secretKey, b.publicKey)
      const sharedB = deriveSharedKey(b.secretKey, a.publicKey)

      const msg = '{"method":"terminal.subscribe","params":{"terminal":"t1"}}'
      const enc = encrypt(msg, sharedA)
      expect(decrypt(enc, sharedB)).toBe(msg)
    })
  })

  describe('destroy', () => {
    it('clears state and stops forwarding', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const received: string[] = []

      ctx.channel.onMessage((plaintext) => {
        received.push(plaintext)
      })

      ctx.channel.destroy()
      ctx.channel.handleRawMessage(encrypt('after destroy', sharedKey))

      expect(received).toEqual([])
    })

    // Why: streaming RPC handlers (terminal.subscribe) retain the
    // encryptedReply closure created inside handleRawMessage. If destroy()
    // runs (mobile disconnect) before a late streaming emit, the closure's
    // captured this.sharedKey is null. Without a guard, encrypt() would
    // call nacl.box.after with a null key and throw an unhandled
    // "unexpected type, use Uint8Array" rejection.
    it('does not throw when streaming emit fires after destroy', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const sentBefore = ctx.ws.sent.length

      let capturedReply: ((response: string) => void) | null = null
      ctx.channel.onMessage((_plaintext, encryptedReply) => {
        capturedReply = encryptedReply
      })

      ctx.channel.handleRawMessage(encrypt('subscribe-trigger', sharedKey))
      expect(capturedReply).not.toBeNull()

      ctx.channel.destroy()

      const callLateEmit = () => capturedReply?.('late streaming frame')
      expect(callLateEmit).not.toThrow()
      expect(ctx.ws.sent.length).toBe(sentBefore)
    })
  })
})
