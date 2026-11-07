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
  let fetchWorktrees: ReturnType<typeof vi.fn<RefreshArgs['fetchWorktrees']>>
  let fetchRepoMetadata: ReturnType<typeof vi.fn<RefreshArgs['fetchRepoMetadata']>>
  let syncViewSettings: ReturnType<typeof vi.fn<RefreshArgs['syncViewSettings']>>
  let unsubscribe: ReturnType<typeof vi.fn<() => void>>
  let stop: (() => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    appState.currentState = 'active'
    appState.listener = null
    appState.remove.mockClear()
    eventListener = null
    fetchWorktrees = vi.fn<RefreshArgs['fetchWorktrees']>().mockResolvedValue(undefined)
    fetchRepoMetadata = vi.fn<RefreshArgs['fetchRepoMetadata']>().mockResolvedValue(undefined)
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
      fetchWorktrees,
      fetchRepoMetadata,
      syncViewSettings,
      sidebarFeed,
      appState: AppState
    })
  }

  afterEach(() => {
    stop?.()
    vi.useRealTimers()
  })

  it('keeps the worktree poll active but skips ticks while backgrounded', async () => {
    start()
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)

    appState.currentState = 'background'
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)

    appState.currentState = 'active'
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)

    stop?.()
    stop = null
    fetchWorktrees.mockClear()
    eventListener?.({ type: 'worktreesChanged', repoId: 'repo-1' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(appState.remove).toHaveBeenCalledOnce()
  })

  it('refreshes worktrees on worktreesChanged and both snapshots after stream replay', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    eventListener?.({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)

    eventListener?.({ type: 'ready', subscriptionId: 'events-1' })
    eventListener?.({ type: 'ready', subscriptionId: 'events-2' })
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ force: true, queueIfInFlight: true })
  })

  it('reads nothing on change notices while hidden and catches up once on return', async () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()
    syncViewSettings.mockClear()

    appState.currentState = 'background'
    eventListener?.({ type: 'worktreesChanged', repoId: 'repo-1' })
    eventListener?.({ type: 'reposChanged' })
    eventListener?.({ type: 'workspaceViewChanged' })
    eventListener?.({
      type: 'sshStateChanged',
      targetId: 'ssh-1',
      state: { targetId: 'ssh-1', status: 'connected' }
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(fetchRepoMetadata).not.toHaveBeenCalled()
    expect(syncViewSettings).not.toHaveBeenCalled()

    appState.currentState = 'active'
    appState.listener?.('active')
    expect(fetchWorktrees).toHaveBeenCalledExactlyOnceWith({
      allowDuringModal: true,
      queueIfInFlight: true
    })
    expect(fetchRepoMetadata).toHaveBeenCalledExactlyOnceWith({
      force: true,
      queueIfInFlight: true
    })
    expect(syncViewSettings).toHaveBeenCalledExactlyOnceWith({ resend: true })
  })

  describe('with the host’s sidebar feed', () => {
    it('reads it at start, on every ready and on foreground, and never polls', async () => {
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

      fetchWorktrees.mockClear()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetchWorktrees).not.toHaveBeenCalled()
    })
  })
})
