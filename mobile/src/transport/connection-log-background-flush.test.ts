import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { subscribeConnectionLogBackgroundFlush } from './connection-log-background-flush'

type AppStateListener = (next: string) => void

let appStateListener: AppStateListener | null = null
const appStateRemove = vi.fn()

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: AppStateListener) => {
      appStateListener = listener
      return { remove: appStateRemove }
    }
  }
}))

describe('subscribeConnectionLogBackgroundFlush', () => {
  let flush: Mock<() => void>

  beforeEach(() => {
    vi.clearAllMocks()
    appStateListener = null
    flush = vi.fn<() => void>()
  })

  it('flushes when the app goes to the background', () => {
    subscribeConnectionLogBackgroundFlush(flush)
    appStateListener?.('background')
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('does not flush on foreground or transient inactive states', () => {
    subscribeConnectionLogBackgroundFlush(flush)
    appStateListener?.('active')
    appStateListener?.('inactive')
    expect(flush).not.toHaveBeenCalled()
  })

  it('removes the listener on unsubscribe', () => {
    const unsubscribe = subscribeConnectionLogBackgroundFlush(flush)
    unsubscribe()
    expect(appStateRemove).toHaveBeenCalledTimes(1)
  })
})
