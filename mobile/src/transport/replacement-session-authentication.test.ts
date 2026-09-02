import { describe, expect, it, vi } from 'vitest'
import { waitForAuthenticated } from './replacement-session-authentication'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

type FakeSession = RpcClient & {
  emit: (state: ConnectionState) => void
  listenerCount: () => number
}

// Why: waitForAuthenticated only touches getState/onStateChange, so the fake keeps to
// those two and tracks unsubscribe so the leak branches are observable.
function fakeSession(
  initial: ConnectionState,
  options: { emitOnSubscribe?: ConnectionState } = {}
) {
  const listeners = new Set<(state: ConnectionState) => void>()
  let state = initial
  const session = {
    getState: () => state,
    onStateChange: (listener: (state: ConnectionState) => void) => {
      listeners.add(listener)
      if (options.emitOnSubscribe) {
        state = options.emitOnSubscribe
        listener(state)
      }
      return () => listeners.delete(listener)
    },
    emit: (next: ConnectionState) => {
      state = next
      // Why: snapshot the set — a listener that unsubscribes during notification
      // must not mutate the collection being iterated.
      const snapshot = Array.from(listeners)
      for (const listener of snapshot) {
        listener(next)
      }
    },
    listenerCount: () => listeners.size
  } as unknown as FakeSession
  return session
}

describe('waitForAuthenticated', () => {
  it('resolves without subscribing when the session is already connected', async () => {
    const session = fakeSession('connected')
    await expect(waitForAuthenticated(session, 1_000)).resolves.toBeUndefined()
    expect(session.listenerCount()).toBe(0)
  })

  it('resolves once the session reaches connected', async () => {
    const session = fakeSession('handshaking')
    const wait = waitForAuthenticated(session, 1_000)
    session.emit('connected')
    await expect(wait).resolves.toBeUndefined()
    expect(session.listenerCount()).toBe(0)
  })

  it.each(['auth-failed', 'disconnected'] as const)('rejects on %s', async (state) => {
    const session = fakeSession('handshaking')
    const wait = waitForAuthenticated(session, 1_000)
    session.emit(state)
    await expect(wait).rejects.toThrow(`replacement session ${state}`)
    expect(session.listenerCount()).toBe(0)
  })

  it('ignores states that are neither success nor terminal', async () => {
    const session = fakeSession('connecting')
    const wait = waitForAuthenticated(session, 1_000)
    session.emit('reconnecting')
    session.emit('handshaking')
    session.emit('connected')
    await expect(wait).resolves.toBeUndefined()
  })

  it('names the phase it timed out in', async () => {
    vi.useFakeTimers()
    try {
      const session = fakeSession('handshaking')
      const wait = waitForAuthenticated(session, 12_000)
      const assertion = expect(wait).rejects.toThrow(
        'replacement session authentication timed out (phase: handshaking)'
      )
      vi.advanceTimersByTime(12_000)
      await assertion
      expect(session.listenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports connecting when the socket never opened', async () => {
    vi.useFakeTimers()
    try {
      const session = fakeSession('connecting')
      const wait = waitForAuthenticated(session, 12_000)
      const assertion = expect(wait).rejects.toThrow('(phase: connecting)')
      vi.advanceTimersByTime(12_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the file arms its timer before subscribing precisely so a synchronous
  // notification during registration cannot leave a 12s timer running.
  it('clears the timer when the notification fires during registration', async () => {
    vi.useFakeTimers()
    try {
      const session = fakeSession('handshaking', { emitOnSubscribe: 'connected' })
      await expect(waitForAuthenticated(session, 12_000)).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
      expect(session.listenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
