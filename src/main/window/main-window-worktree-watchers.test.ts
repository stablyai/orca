import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  sync: vi.fn(),
  upgrade: vi.fn(),
  preferred: vi.fn()
}))
vi.mock('../ipc/worktree-base-directory-watcher', () => ({
  setWorktreeBaseDirectoryWatcherSyncContext: mocks.context,
  scheduleWorktreeBaseDirectoryWatcherSync: mocks.sync
}))
vi.mock('../ipc/folder-repo-git-upgrade', () => ({ startFolderRepoGitUpgradeWatch: mocks.upgrade }))
vi.mock('./native-desktop-windows', () => ({ preferredNativeDesktopWindow: mocks.preferred }))
vi.mock('./desktop-renderer-registry', () => ({ desktopWindowId: () => 'native' }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    webContents = {}
    close(): void {
      this.emit('closed')
    }
  }
  return { BrowserWindow: Window }
})

import { BrowserWindow } from 'electron'
import { attachMainWindowWorktreeWatchers } from './main-window-worktree-watchers'

beforeEach(() => vi.resetAllMocks())

describe('native worktree watcher windows', () => {
  it('binds each attachment and transfers both watchers when the newest or first window closes', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked watchers retain the store without reading it.
    const store = {} as Store
    const first = new BrowserWindow({ show: false })
    const second = new BrowserWindow({ show: false })
    const third = new BrowserWindow({ show: false })
    for (const window of [first, second, third]) {
      attachMainWindowWorktreeWatchers(store, window)
    }
    mocks.preferred.mockReturnValue(second)
    first.close()
    expect(mocks.context).toHaveBeenLastCalledWith(store, second)
    expect(mocks.sync).toHaveBeenLastCalledWith(store, second)
    expect(mocks.upgrade).toHaveBeenLastCalledWith(store, second)
    mocks.preferred.mockReturnValue(second)
    third.close()
    expect(mocks.upgrade).toHaveBeenLastCalledWith(store, second)
    mocks.context.mockClear()
    mocks.preferred.mockReturnValue(null)
    second.close()
    expect(mocks.context).not.toHaveBeenCalled()
  })
})
