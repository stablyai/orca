import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { subscribeConnectionLogBackgroundFlush } from './connection-log-background-flush'

type AppStateListener = (next: string) => void

const appStateListeners = new Map<string, Set<AppStateListener>>()
const appStateRemove = vi.fn()
const subscriptions = new Set<() => void>()

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (event: string, listener: AppStateListener) => {
      const listeners = appStateListeners.get(event) ?? new Set<AppStateListener>()
      appStateListeners.set(event, listeners)
      listeners.add(listener)
      return {
        remove: () => {
          appStateRemove()
          listeners.delete(listener)
        }
      }
    }
  }
}))

function subscribe(flush: () => void): () => void {
  const unsubscribe = subscribeConnectionLogBackgroundFlush(flush)
  subscriptions.add(unsubscribe)
  return () => {
    subscriptions.delete(unsubscribe)
    unsubscribe()
  }
}

function emitAppState(next: string): void {
  for (const listener of appStateListeners.get('change') ?? []) {
    listener(next)
  }
}

describe('subscribeConnectionLogBackgroundFlush', () => {
  let flush: Mock<() => void>

  beforeEach(() => {
    vi.clearAllMocks()
    appStateListeners.clear()
    flush = vi.fn<() => void>()
  })

  afterEach(() => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
    subscriptions.clear()
    expect([...appStateListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })

  it('flushes when the app goes to the background', () => {
    subscribe(flush)
    emitAppState('background')
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('does not flush on foreground or transient inactive states', () => {
    subscribe(flush)
    expect(appStateListeners.get('change')?.size).toBe(1)
    emitAppState('active')
    emitAppState('inactive')
    expect(flush).not.toHaveBeenCalled()
  })

  it('removes the listener on unsubscribe', () => {
    const otherFlush = vi.fn()
    const unsubscribe = subscribe(flush)
    subscribe(otherFlush)
    unsubscribe()
    emitAppState('background')
    expect(flush).not.toHaveBeenCalled()
    expect(otherFlush).toHaveBeenCalledTimes(1)
    expect(appStateRemove).toHaveBeenCalledTimes(1)
  })
})
