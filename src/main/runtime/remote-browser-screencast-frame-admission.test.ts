import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { deriveSharedKey, encrypt, generateKeyPair } from '../../shared/e2ee-crypto'
import { REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES } from '../../shared/remote-runtime-memory-limits'
import { startBrowserScreencast } from '../browser/browser-screencast-stream'
import { E2EEChannel } from './rpc/e2ee-channel'
import { sendRemoteBrowserScreencastFrame } from './remote-browser-screencast-frame-admission'

function createMockWebContents() {
  let attached = false
  const dbg = new EventEmitter() as EventEmitter & {
    isAttached: ReturnType<typeof vi.fn>
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
  }
  dbg.isAttached = vi.fn(() => attached)
  dbg.attach = vi.fn(() => {
    attached = true
  })
  dbg.detach = vi.fn(() => {
    attached = false
  })
  dbg.sendCommand = vi.fn(async () => ({}))
  return { isDestroyed: vi.fn(() => false), debugger: dbg }
}

// Why: exercises the real E2EE channel so the oracle fails if an over-limit frame ever reaches
// the transport that answers it with close code 1013.
function createRuntimeBinarySender() {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const ws = {
    OPEN: 1 as const,
    readyState: 1,
    send: vi.fn(),
    close: vi.fn()
  }
  const onTransportError = vi.fn((code: number, reason: string) => ws.close(code, reason))
  const channel = new E2EEChannel(ws as never, {
    serverSecretKey: serverKeys.secretKey,
    resolveAuthenticatedDevice: (token) =>
      token === 'valid-token'
        ? { deviceId: 'device-1', deviceToken: token, scope: 'runtime' }
        : null,
    onReady: vi.fn(),
    onError: onTransportError
  })
  const sharedKey = deriveSharedKey(clientKeys.secretKey, serverKeys.publicKey)
  channel.handleRawMessage(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(clientKeys.publicKey).toString('base64')
    })
  )
  channel.handleRawMessage(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), sharedKey)
  )
  let sendBinary: ((bytes: Uint8Array<ArrayBufferLike>) => boolean | void) | undefined
  channel.onMessage((_plaintext, _sendText, sendBinaryReply) => {
    sendBinary = sendBinaryReply
  })
  channel.handleRawMessage(encrypt('start-screencast', sharedKey))
  if (!sendBinary) {
    throw new Error('Runtime binary sender was not established')
  }
  return { channel, ws, onTransportError, sendBinary }
}

describe('sendRemoteBrowserScreencastFrame', () => {
  it('reports an over-limit frame as handled so the producer does not retry it', () => {
    const sendBinary = vi.fn(() => true)
    const oversized = new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1)

    expect(sendRemoteBrowserScreencastFrame(sendBinary, oversized)).toBe(true)
    expect(sendBinary).not.toHaveBeenCalled()
  })

  it('still forwards backpressure for a frame the transport can accept', () => {
    const withinLimit = new Uint8Array(1024)

    expect(
      sendRemoteBrowserScreencastFrame(
        vi.fn(() => false),
        withinLimit
      )
    ).toBe(false)
    expect(
      sendRemoteBrowserScreencastFrame(
        vi.fn(() => true),
        withinLimit
      )
    ).toBe(true)
    expect(sendRemoteBrowserScreencastFrame(vi.fn(), withinLimit)).toBe(true)
  })

  it('drops an oversized encoded frame without closing or stalling the paired stream', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const transport = createRuntimeBinarySender()
    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      everyNthFrame: 1,
      minFrameIntervalMs: 0,
      onFrame: (bytes) => sendRemoteBrowserScreencastFrame(transport.sendBinary, bytes)
    })

    try {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.alloc(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1).toString('base64'),
        sessionId: 42,
        metadata: {}
      })
      await Promise.resolve()

      expect(transport.onTransportError).not.toHaveBeenCalled()
      expect(transport.ws.close).not.toHaveBeenCalled()
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 42
      })
      const sendsAfterDrop = transport.ws.send.mock.calls.length
      await vi.advanceTimersByTimeAsync(500)
      expect(transport.ws.send).toHaveBeenCalledTimes(sendsAfterDrop)

      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('next-frame').toString('base64'),
        sessionId: 43,
        metadata: {}
      })
      await Promise.resolve()

      expect(transport.onTransportError).not.toHaveBeenCalled()
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 43
      })
      expect(transport.ws.send.mock.calls.length).toBeGreaterThan(sendsAfterDrop)
    } finally {
      session.stop()
      await session.done
      transport.channel.destroy()
      vi.useRealTimers()
    }
  })
})
