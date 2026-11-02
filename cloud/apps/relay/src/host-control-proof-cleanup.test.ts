import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerProof,
  hostControlProofFixture as fixture,
  openProof,
  ProofSocket
} from './test-fixtures/host-control-proof.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('host control proof cleanup', () => {
  it('allocates no hello stage for an already closed peer', () => {
    const h = fixture()
    const socket = new ProofSocket()
    socket.peerClose()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.verify).not.toHaveBeenCalled()
  })

  it('releases the host hello timer and listeners when its peer closes early', () => {
    const h = fixture()
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    expect(vi.getTimerCount()).toBe(1)
    expect(socket.listenerCount('message')).toBe(1)
    socket.peerClose()
    expect({
      timers: vi.getTimerCount(),
      message: socket.listenerCount('message'),
      close: socket.listenerCount('close')
    }).toEqual({ timers: 0, message: 0, close: 0 })
    vi.advanceTimersByTime(2000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.database.query).not.toHaveBeenCalled()
  })

  it('preserves the exact hello deadline and refusal while releasing its message listener', () => {
    const h = fixture()
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    vi.advanceTimersByTime(1999)
    expect(socket.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host hello timeout'
    )
    expect(socket.listenerCount('message')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the challenge timer and listeners when its peer closes before proof', async () => {
    const h = fixture()
    const socket = await openProof(h)
    expect(vi.getTimerCount()).toBe(1)
    expect(socket.listenerCount('message')).toBe(1)
    socket.peerClose()
    expect({
      timers: vi.getTimerCount(),
      message: socket.listenerCount('message'),
      close: socket.listenerCount('close')
    }).toEqual({ timers: 0, message: 0, close: 0 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(h.activate).not.toHaveBeenCalled()
    expect(h.database.query).not.toHaveBeenCalled()
  })

  it('preserves the exact proof deadline and refusal with no leftover listener', async () => {
    const h = fixture()
    const socket = await openProof(h)
    await vi.advanceTimersByTimeAsync(9999)
    expect(socket.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host proof timeout'
    )
    expect(socket.listenerCount('message')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
    expect(h.recordAuth).not.toHaveBeenCalled()
  })

  it('does no challenge crypto, send, timer or registration after a closed peer finishes verification', async () => {
    const h = fixture()
    let finish!: (valid: boolean) => void
    h.verify.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const generateKey = vi.spyOn(nacl.box, 'keyPair')
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from(h.hello), false)
    expect(h.verify).toHaveBeenCalledOnce()
    socket.peerClose()
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.send).not.toHaveBeenCalled()
    expect(generateKey).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
    expect(h.database.query).not.toHaveBeenCalled()
    expect(
      h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })
    ).toBeNull()
  })

  it.each([false, true])('preserves invalid first-frame refusal (binary=%s)', (binary) => {
    const h = fixture()
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from('{}'), binary)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      binary ? 'host hello must be text' : 'invalid host hello'
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves invalid proof authentication failure (binary=%s)',
    async (binary) => {
      const h = fixture()
      const socket = await openProof(h)
      socket.emit('message', Buffer.from('{}'), binary)
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(
        RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
        'invalid host proof'
      )
      expect(h.recordAuth).toHaveBeenCalledExactlyOnceWith(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(socket.listenerCount('close')).toBe(0)
      expect(h.activate).not.toHaveBeenCalled()
    }
  )

  it('allocates no proof wait when sending the challenge closes its peer', async () => {
    const h = fixture()
    const socket = new ProofSocket()
    socket.send.mockImplementation(() => socket.peerClose())
    await openProof(h, socket)
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
  })

  it('keeps the existing diagnostic and refusal when challenge send throws', async () => {
    const h = fixture()
    const socket = new ProofSocket()
    socket.send.mockImplementation(() => {
      throw new Error('synthetic send failure')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await openProof(h, socket)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
      'relay temporarily unavailable'
    )
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[orca-relay] host hello proof failed: synthetic send failure'
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
  })

  it('contains assignment lookup rejection with its existing close and diagnostic', async () => {
    const h = fixture()
    h.verify.mockRejectedValueOnce(new Error('synthetic lookup failure'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from(h.hello), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
      'relay temporarily unavailable'
    )
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[orca-relay] host hello proof failed: synthetic lookup failure'
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
  })

  it('keeps a newer same-host peer live when the old proof peer closes', async () => {
    const h = fixture()
    const oldPeer = await openProof(h)
    const replacement = await openProof(h)
    oldPeer.peerClose()
    expect(vi.getTimerCount()).toBe(1)
    answerProof(replacement, h.keyPair)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.activate).toHaveBeenCalledOnce()
    expect(h.recordAuth).toHaveBeenCalledExactlyOnceWith(true)
    expect(
      h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })?.socket
    ).toBe(replacement)
    expect(replacement.send).toHaveBeenCalledTimes(2)
    expect(replacement.listenerCount('message')).toBe(1)
    expect(replacement.listenerCount('close')).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(oldPeer.close).not.toHaveBeenCalled()
    expect(replacement.close).not.toHaveBeenCalled()
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
