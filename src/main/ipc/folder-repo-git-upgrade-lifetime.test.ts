import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'

const fake = vi.hoisted(() => ({
  stat: vi.fn(),
  git: vi.fn(),
  root: vi.fn(),
  prepare: vi.fn(),
  invalidate: vi.fn(),
  reposChanged: vi.fn(),
  worktreesChanged: vi.fn(),
  unsubscribe: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: fake.stat }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }))
vi.mock('../git/repo', () => ({ isGitRepo: fake.git, getGitRepoRoot: fake.root }))
vi.mock('../worktree-root-preparation', () => ({ prepareLocalWorktreeRootForRepo: fake.prepare }))
vi.mock('./registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: fake.invalidate
}))
vi.mock('./repos/repos-changed-notification', () => ({ notifyReposChanged: fake.reposChanged }))
vi.mock('./worktree-remote', () => ({ notifyWorktreesChanged: fake.worktreesChanged }))
vi.mock('./worktree-base-directory-poller', () => ({
  WORKTREE_BASE_BACKSTOP_TICKS: 15,
  WORKTREE_BASE_POLL_INTERVAL_MS: 2000,
  createWorktreePollerWindowVisibility: () => ({
    isWindowVisible: () => true,
    onWindowBecameVisible: () => fake.unsubscribe
  })
}))

import {
  startFolderRepoGitUpgradeWatch,
  stopFolderRepoGitUpgradeWatch
} from './folder-repo-git-upgrade'
import { wakeFolderRepoGitUpgradeWatch } from './folder-repo-git-upgrade-wake'

const marker = { mtimeMs: 1, ctimeMs: 1, ino: 1 }
const root = join('mock', 'folder')
function folder(path = root): Repo {
  return { id: path, path, kind: 'folder', displayName: 'Folder', addedAt: 0, badgeColor: 'blue' }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function begin(repos = [folder()], meta: ReturnType<Store['getAllWorktreeMeta']> = {}) {
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getAllWorktreeMeta: () => meta,
    updateRepo: vi.fn((id: string, patch: Partial<Repo>) => {
      const repo = repos.find((row) => row.id === id)
      return repo ? Object.assign(repo, patch) : null
    })
  }
  const window = { isDestroyed: () => false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every Store method reachable by this poller is supplied; root preparation is mocked.
  const storeFixture = store as unknown as Store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Visibility and notifiers are mocked; only isDestroyed is read on this window.
  const windowFixture = window as BrowserWindow
  startFolderRepoGitUpgradeWatch(storeFixture, windowFixture, { pollIntervalMs: 25 })
  return { store, window }
}
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  fake.stat.mockResolvedValue(marker)
  fake.git.mockReturnValue(true)
  fake.root.mockImplementation((path: string) => path)
  fake.prepare.mockResolvedValue(undefined)
})
afterEach(() => {
  stopFolderRepoGitUpgradeWatch()
  vi.useRealTimers()
})

describe('folder repo upgrade poll lifetime', () => {
  it('does not start Git checks or mutations when a marker arrives after stop', async () => {
    const pending = deferred<typeof marker>()
    fake.stat.mockReturnValue(pending.promise)
    const { store } = begin()
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.stat).toHaveBeenCalledTimes(1)
    stopFolderRepoGitUpgradeWatch()
    pending.resolve(marker)
    await flush()
    expect(fake.git).not.toHaveBeenCalled()
    expect(fake.root).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(fake.prepare).not.toHaveBeenCalled()
    expect(fake.invalidate).not.toHaveBeenCalled()
    expect(fake.reposChanged).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the remaining folder scan when a pending marker fails after stop', async () => {
    const pending = deferred<typeof marker>()
    fake.stat.mockReturnValue(pending.promise)
    begin([folder(), folder(join('mock', 'other'))])
    await vi.advanceTimersByTimeAsync(25)
    stopFolderRepoGitUpgradeWatch()
    pending.reject(new Error('ENOENT'))
    await flush()
    expect(fake.stat).toHaveBeenCalledTimes(1)
    expect(fake.git).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restore a rejected marker after its owner stops', async () => {
    fake.git.mockImplementationOnce(() => {
      stopFolderRepoGitUpgradeWatch()
      return false
    })
    begin()
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.git).toHaveBeenCalledTimes(1)
    begin()
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.git).toHaveBeenCalledTimes(2)
    expect(fake.prepare).toHaveBeenCalledTimes(1)
  })

  it('does not prune a replacement watcher cache when earlier preparation finishes', async () => {
    const pending = deferred<void>()
    fake.prepare.mockReturnValueOnce(pending.promise)
    begin()
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.prepare).toHaveBeenCalledTimes(1)
    stopFolderRepoGitUpgradeWatch()
    fake.git.mockReturnValue(false)
    begin([folder(join('mock', 'replacement'))])
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.git).toHaveBeenCalledTimes(2)
    pending.resolve()
    await flush()
    await vi.advanceTimersByTimeAsync(50)
    expect(fake.git).toHaveBeenCalledTimes(2)
    expect(fake.reposChanged).not.toHaveBeenCalled()
    expect(fake.invalidate).toHaveBeenCalledTimes(1)
  })

  it('keeps active upgrade preparation, cache invalidation and notifications', async () => {
    const { store, window } = begin()
    await vi.advanceTimersByTimeAsync(25)
    expect(store.updateRepo).toHaveBeenCalledWith(root, {
      kind: 'git',
      folderUpgradeGitRootPath: root,
      externalWorktreeVisibility: 'hide'
    })
    expect(fake.prepare).toHaveBeenCalledTimes(1)
    expect(fake.invalidate).toHaveBeenCalledTimes(1)
    expect(fake.reposChanged).toHaveBeenCalledWith(window)
    expect(fake.worktreesChanged).toHaveBeenCalledWith(window, root)
  })

  it('retries a missing marker and dedupes stable rejected markers', async () => {
    fake.stat.mockRejectedValueOnce(new Error('ENOENT'))
    fake.git.mockReturnValue(false)
    begin()
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.stat).toHaveBeenCalledTimes(4)
    expect(fake.git).toHaveBeenCalledTimes(1)
    fake.stat.mockResolvedValue({ ...marker, mtimeMs: 2 })
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.git).toHaveBeenCalledTimes(2)
  })

  it('still excludes SSH, WSL, nonlocal execution hosts and git projects', async () => {
    begin([
      { ...folder(), connectionId: 'ssh' },
      folder(String.raw`\\wsl$\Ubuntu\home\project`),
      { ...folder(), executionHostId: 'runtime:other' },
      { ...folder(), kind: 'git' }
    ])
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.stat).not.toHaveBeenCalled()
    expect(fake.git).not.toHaveBeenCalled()
  })

  it('does not upgrade a project with extra folder workspaces', async () => {
    const { store } = begin([folder()], {
      [`${root}::${root}::workspace:extra`]: {
        displayName: 'Extra',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    })
    await vi.advanceTimersByTimeAsync(25)
    expect(fake.stat).toHaveBeenCalledTimes(1)
    expect(fake.git).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('releases timer, wake and visibility ownership on stop', async () => {
    begin()
    stopFolderRepoGitUpgradeWatch()
    wakeFolderRepoGitUpgradeWatch()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
    expect(fake.stat).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
