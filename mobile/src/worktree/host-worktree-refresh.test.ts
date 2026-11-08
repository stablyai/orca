import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHostWorktreeRefresh } from './host-worktree-refresh'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

const appState = vi.hoisted(() => ({
  currentState: 'active',
  listener: null as ((state: string) => void) | null,
  remove: vi.fn()
}))

const AppState = {
  get currentState() {
    return appState.currentState
  },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    appState.listener = listener
    return { remove: appState.remove }
  }
}

type RefreshArgs = Parameters<typeof startHostWorktreeRefresh>[0]

describe('startHostWorktreeRefresh', () => {
  let eventListener: ((payload: unknown) => void) | null
  let refreshWorktrees: ReturnType<typeof vi.fn<RefreshArgs['refreshWorktrees']>>
  let syncViewSettings: ReturnType<typeof vi.fn<RefreshArgs['syncViewSettings']>>
  let unsubscribe: ReturnType<typeof vi.fn<() => void>>
  let stop: (() => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    appState.currentState = 'active'
    appState.listener = null
    appState.remove.mockClear()
    eventListener = null
    refreshWorktrees = vi.fn<RefreshArgs['refreshWorktrees']>()
    syncViewSettings = vi.fn<RefreshArgs['syncViewSettings']>().mockResolvedValue(undefined)
    unsubscribe = vi.fn<() => void>()
    stop = null
  })

  function start(
    sidebarFeed: Parameters<typeof startHostWorktreeRefresh>[0]['sidebarFeed'] = null
  ): void {
    const client = stubRpcClient({
      subscribe: (_method, _params, listener) => {
        eventListener = listener
        return unsubscribe
      }
    })
    stop = startHostWorktreeRefresh({
      client,
      refreshWorktrees,
      syncViewSettings,
      sidebarFeed,
      appState: AppState
    })
  }

  afterEach(() => {
    stop?.()
    vi.useRealTimers()
  })

  it('reads nothing on change notices while hidden and catches up once on return', () => {
    start()
    syncViewSettings.mockClear()

    appState.currentState = 'background'
    eventListener?.({ type: 'workspaceViewChanged' })
    eventListener?.({ type: 'workspaceViewChanged' })
    expect(syncViewSettings).not.toHaveBeenCalled()

    appState.currentState = 'active'
    appState.listener?.('active')
    expect(syncViewSettings).toHaveBeenCalledExactlyOnceWith({ resend: true })
  })

  describe('with the host’s sidebar feed', () => {
    it('reads it at start, on every ready and on foreground', () => {
      const sidebarFeed = { refresh: vi.fn(), changed: vi.fn(), onInstalled: vi.fn(() => () => {}) }
      start(sidebarFeed)
      expect(sidebarFeed.refresh).toHaveBeenCalledTimes(1)
      eventListener?.({ type: 'ready', subscriptionId: 'events-1' })
      expect(sidebarFeed.refresh).toHaveBeenCalledTimes(2)
      eventListener?.({ type: 'ready', subscriptionId: 'events-2' })
      expect(sidebarFeed.refresh).toHaveBeenCalledTimes(3)
      expect(syncViewSettings).toHaveBeenCalledWith({ resend: true })
      appState.listener?.('active')
      expect(sidebarFeed.refresh).toHaveBeenCalledTimes(4)
    })
  })
})
