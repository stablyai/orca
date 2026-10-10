import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./worktree-remote', () => ({
  notifyWorktreesChanged: vi.fn()
}))

import { notifyWorktreesChanged } from './worktree-remote'
import {
  notifyWatchedWorktreeCatalogChanged,
  setWorktreeCatalogRemoteClientNotifier
} from './watched-worktree-catalog-notification'

const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

describe('watched worktree catalog notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setWorktreeCatalogRemoteClientNotifier(null)
  })

  it('refreshes the host and paired clients once', () => {
    const notifyRemote = vi.fn()
    setWorktreeCatalogRemoteClientNotifier({
      notifyWorktreeCatalogChangedForRemoteClients: notifyRemote
    })

    notifyWatchedWorktreeCatalogChanged(mainWindow as never, 'repo-1')

    expect(notifyWorktreesChanged).toHaveBeenCalledWith(mainWindow, 'repo-1')
    expect(notifyRemote).toHaveBeenCalledOnce()
    expect(notifyRemote).toHaveBeenCalledWith('repo-1')
  })

  it('keeps the host refresh when remote publication fails', () => {
    const error = new Error('stream unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setWorktreeCatalogRemoteClientNotifier({
      notifyWorktreeCatalogChangedForRemoteClients: () => {
        throw error
      }
    })

    expect(() => notifyWatchedWorktreeCatalogChanged(mainWindow as never, 'repo-1')).not.toThrow()
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(mainWindow, 'repo-1')
    expect(consoleError).toHaveBeenCalledWith(
      '[worktrees] failed to notify remote clients of watched catalog change',
      error
    )
  })

  it('keeps nested SSH discoveries local until the event can carry owner identity', () => {
    const notifyRemote = vi.fn()
    setWorktreeCatalogRemoteClientNotifier({
      notifyWorktreeCatalogChangedForRemoteClients: notifyRemote
    })

    notifyWatchedWorktreeCatalogChanged(mainWindow as never, 'repo-1', 'ssh-target-1')

    expect(notifyWorktreesChanged).toHaveBeenCalledWith(mainWindow, 'repo-1')
    expect(notifyRemote).not.toHaveBeenCalled()
  })
})
