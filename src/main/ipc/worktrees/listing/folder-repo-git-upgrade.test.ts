import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Store } from '../../../persistence/loading-store/store'

const { inspectFolderToGitConversion } = vi.hoisted(() => ({
  inspectFolderToGitConversion: vi.fn()
}))

vi.mock('../../../workspaces/catalog/folder-repo-git-conversion', () => ({
  inspectFolderToGitConversion
}))
vi.mock('../worktree-remote', () => ({ notifyWorktreesChanged: vi.fn() }))
vi.mock('../../repos/repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('../removal/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('../../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))

import {
  startFolderRepoGitUpgradeWatch,
  stopFolderRepoGitUpgradeWatch
} from './folder-repo-git-upgrade'

const POLL_MS = 10
const OWNERSHIP_ERROR = 'Git detected dubious ownership in repository'

describe('folder repo git upgrade watch', () => {
  let root: string

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    inspectFolderToGitConversion.mockReset()
    root = await mkdtemp(join(tmpdir(), 'folder-repo-upgrade-'))
  })

  afterEach(async () => {
    stopFolderRepoGitUpgradeWatch()
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  it('backs off re-probing a Git-refused folder and upgrades it once trusted', async () => {
    const repoPath = join(root, 'project')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    const repo: Repo = {
      id: 'folder-repo',
      path: repoPath,
      displayName: 'project',
      badgeColor: '#000000',
      addedAt: 0,
      kind: 'folder'
    }
    const updateRepo = vi.fn((_target: Repo, updates: Partial<Repo>) =>
      Object.assign(repo, updates)
    )
    const getRepos = vi.fn(() => [repo])
    const store = {
      getRepos,
      getRepo: () => repo,
      updateRepo,
      getAllWorktreeMeta: () => ({})
    }
    const window = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { send: vi.fn() }
    }
    inspectFolderToGitConversion.mockResolvedValue({
      conversion: null,
      ownershipError: OWNERSHIP_ERROR
    })

    startFolderRepoGitUpgradeWatch(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the poller only reads repos/meta and calls updateRepo.
      store as unknown as Store,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the poller only checks destroyed/visible state and forwards it to mocked notifiers.
      window as unknown as BrowserWindow,
      { pollIntervalMs: POLL_MS, idlePollIntervalMs: POLL_MS }
    )
    await vi.waitFor(() => expect(inspectFolderToGitConversion).toHaveBeenCalledTimes(1))

    // Poll ticks inside the backoff window spawn no further Git probes.
    const pollsBeforeBackoff = getRepos.mock.calls.length
    await vi.waitFor(() =>
      expect(getRepos.mock.calls.length).toBeGreaterThanOrEqual(pollsBeforeBackoff + 5)
    )
    expect(inspectFolderToGitConversion).toHaveBeenCalledTimes(1)

    // Trusting the repo leaves .git untouched; the probe after the window upgrades it.
    inspectFolderToGitConversion.mockResolvedValue({
      conversion: { updates: { folderUpgradeGitRootPath: repoPath }, rootSpellingMatches: true }
    })
    vi.advanceTimersByTime(2 * 60_000)
    await vi.waitFor(() =>
      expect(updateRepo).toHaveBeenCalledWith(repo, {
        kind: 'git',
        folderUpgradeGitRootPath: repoPath,
        externalWorktreeVisibility: 'hide'
      })
    )
    expect(inspectFolderToGitConversion).toHaveBeenCalledTimes(2)
  })
})
