import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../src/shared/relay-host-close-reason'

vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: () => ({}) }
}))

vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEV2PhysicalChannel: class {
    start = vi.fn()
    handleMessage = vi.fn(async () => {})
    sendText = vi.fn(() => true)
    sendBinary = vi.fn(() => true)
    dispose = vi.fn()
  }
}))

import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'

class ErrorTimerSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  send = vi.fn((_frame: string) => {})
  close = vi.fn(() => {})
}

function linkFixture(): {
  link: MobileRelayE2eeLink
  socket: ErrorTimerSocket
  onError: ReturnType<typeof vi.fn>
  onHostCloseReason: ReturnType<typeof vi.fn>
} {
  const socket = new ErrorTimerSocket()
  const onError = vi.fn()
  const onHostCloseReason = vi.fn()
  const link = new MobileRelayE2eeLink({
    endpoint: {
      cellUrl: 'https://relay-c1.onorca.dev',
      relayHostId: 'AbCdEf0123_-xyZ9'
    },
    credential: 'credential',
    expectedCredentialKind: 'resume',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'desktop-key',
    onAuthenticated: vi.fn(),
    onText: vi.fn(),
    onBinary: vi.fn(),
    onError,
    onHostCloseReason,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The observed socket implements every WebSocket member this link and mocked channel use.
    createSocket: () => socket as unknown as WebSocket
  })
  return { link, socket, onError, onHostCloseReason }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('closed relay link transport-error timer ownership', () => {
  it('starts no fallback for errors queued after explicit close', () => {
    const { link, socket, onError } = linkFixture()
    link.close()
    socket.onerror?.()
    socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(onError).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('starts no fallback after failure and preserves the original thrown error', () => {
    const { socket, onError } = linkFixture()
    const failure = new Error('relay auth write failed')
    socket.send.mockImplementation(() => {
      throw failure
    })
    socket.onopen?.()
    socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it.each(['close', 'fail', 'fallback'])(
    'starts no fallback for a reentrant socket.close error during %s',
    async (mode) => {
      const { link, socket, onError } = linkFixture()
      socket.close.mockImplementation(() => {
        socket.onerror?.()
      })
      if (mode === 'close') {
        link.close()
        expect(onError).not.toHaveBeenCalled()
      } else if (mode === 'fail') {
        socket.onclose?.({ code: 4409, reason: '' })
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: 'relay_outer_4409' })
        )
      } else {
        socket.onerror?.()
        await vi.advanceTimersByTimeAsync(250)
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: 'relay_outer_1006' })
        )
      }
      expect(vi.getTimerCount()).toBe(0)
      expect(socket.close).toHaveBeenCalledOnce()
    }
  )

  it('starts no fallback after normal close and still reports its host reason', () => {
    const { socket, onError, onHostCloseReason } = linkFixture()
    socket.onclose?.({ code: 4409, reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT })
    socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'relay_outer_4409' })
    )
    expect(onHostCloseReason).toHaveBeenCalledExactlyOnceWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

  it('retains one live fallback and the exact missing-close grace deadline', async () => {
    const { socket, onError } = linkFixture()
    socket.onerror?.()
    socket.onerror?.()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(onError).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'relay_outer_1006' })
    )
    expect(socket.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a typed close and host reason during the live error grace', async () => {
    const { socket, onError, onHostCloseReason } = linkFixture()
    socket.onerror?.()
    await vi.advanceTimersByTimeAsync(249)
    socket.onclose?.({ code: 4409, reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'relay_outer_4409' })
    )
    expect(onHostCloseReason).toHaveBeenCalledExactlyOnceWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

  it('retains late host-reason reporting after a rejected handshake', async () => {
    const { socket, onError, onHostCloseReason } = linkFixture()
    socket.onmessage?.({ data: JSON.stringify({ type: 'relay-hello', ok: false, code: 4409 }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'relay_outer_4409' })
    )
    socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    socket.onclose?.({ code: 4409, reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT })
    expect(onHostCloseReason).toHaveBeenCalledExactlyOnceWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    expect(onError).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a replacement link independent and leaves no timer after its close', async () => {
    const old = linkFixture()
    old.link.close()
    const replacement = linkFixture()
    old.socket.onerror?.()
    replacement.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(1)
    replacement.socket.onclose?.({ code: 4409, reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(old.onError).not.toHaveBeenCalled()
    expect(replacement.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'relay_outer_4409' })
    )
    expect(replacement.onHostCloseReason).toHaveBeenCalledExactlyOnceWith(
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
  })
})
