import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { startHostWorktreeRefresh } from './host-worktree-refresh'

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

describe('startHostWorktreeRefresh', () => {
  let eventListener: ((payload: unknown) => void) | null
  let fetchWorktrees: ReturnType<typeof vi.fn>
  let fetchRepoMetadata: ReturnType<typeof vi.fn>
  let syncViewSettings: ReturnType<typeof vi.fn>
  let unsubscribe: ReturnType<typeof vi.fn>
  let stop: (() => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    appState.currentState = 'active'
    appState.listener = null
    appState.remove.mockClear()
    eventListener = null
    fetchWorktrees = vi.fn().mockResolvedValue(undefined)
    fetchRepoMetadata = vi.fn().mockResolvedValue(undefined)
    syncViewSettings = vi.fn().mockResolvedValue(undefined)
    unsubscribe = vi.fn()
    stop = null
  })

  function start(
    sidebarFeed: Parameters<typeof startHostWorktreeRefresh>[0]['sidebarFeed'] = null
  ): void {
    const client = {
      subscribe: vi.fn(
        (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
          eventListener = listener
          return unsubscribe
        }
      )
    } as unknown as RpcClient
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
  })

  it('refreshes both snapshots immediately on foreground return', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    appState.currentState = 'active'
    appState.listener?.('active')

    expect(fetchWorktrees).toHaveBeenCalledWith({ allowDuringModal: true })
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ queueIfInFlight: true })
  })

  it('polls repo metadata on the interval while foregrounded and skips it while backgrounded', async () => {
    start()
    // Mount force-fetch.
    expect(fetchRepoMetadata).toHaveBeenCalledTimes(1)

    // Foregrounded: repo.list rides the interval as a convergence safety-net for hosts on an
    // older build, whose Settings edits emit no runtime reposChanged (the callee self-throttles).
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetchWorktrees).toHaveBeenCalledTimes(4)
    expect(fetchRepoMetadata).toHaveBeenCalledTimes(4)

    // Backgrounded: neither snapshot is polled.
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()
    appState.currentState = 'background'
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(fetchRepoMetadata).not.toHaveBeenCalled()
  })

  it('reads the Workspace options at start, resending what the last connection left unanswered', () => {
    start()
    expect(syncViewSettings).toHaveBeenCalledExactlyOnceWith({ resend: true })
  })

  it('re-reads only the shared Workspace options on workspaceViewChanged', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()
    syncViewSettings.mockClear()

    eventListener?.({ type: 'workspaceViewChanged' })

    expect(syncViewSettings).toHaveBeenCalledExactlyOnceWith()
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(fetchRepoMetadata).not.toHaveBeenCalled()
  })

  it('refreshes worktrees and repo metadata on reposChanged', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    eventListener?.({ type: 'reposChanged' })

    expect(fetchWorktrees).toHaveBeenCalledOnce()
    expect(fetchRepoMetadata).toHaveBeenCalledOnce()
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ force: true, queueIfInFlight: true })
  })

  it('re-reads repo metadata, which carries SSH host health, on sshStateChanged', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    eventListener?.({
      type: 'sshStateChanged',
      targetId: 'ssh-1',
      state: { targetId: 'ssh-1', status: 'reconnecting' }
    })

    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ force: true, queueIfInFlight: true })
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

    it('re-reads each row’s live content on every install, queued behind a read in flight', () => {
      let installed = (): void => {}
      const stopFollowing = vi.fn()
      const sidebarFeed = {
        refresh: vi.fn(),
        changed: vi.fn(),
        onInstalled: vi.fn((listener: () => void) => {
          installed = listener
          return stopFollowing
        })
      }
      start(sidebarFeed)
      fetchWorktrees.mockClear()
      installed()
      expect(fetchWorktrees).toHaveBeenCalledWith({ queueIfInFlight: true })
      stop?.()
      stop = null
      expect(stopFollowing).toHaveBeenCalledOnce()
    })

    it('hands each change notice to the feed', () => {
      const sidebarFeed = { refresh: vi.fn(), changed: vi.fn(), onInstalled: vi.fn(() => () => {}) }
      start(sidebarFeed)
      eventListener?.({ type: 'sidebarInputsChanged', generation: 'g', revision: 4 })
      expect(sidebarFeed.changed).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 'g', revision: 4 })
      )
    })
  })
})
