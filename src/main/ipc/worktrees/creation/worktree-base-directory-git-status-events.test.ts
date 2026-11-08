import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { partialRuntimeStore } from '../../../runtime/orca-runtime-tests/runtime-store-partial-fixture'
import { makeStore } from '../../../runtime/paired-client-navigation-test-harness'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { setWorktreeCatalogRemoteClientNotifier } from '../../watched-worktree-catalog-notification'
import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import { createWorktreeHeadIdentityRefreshState } from './worktree-head-identity-refresh'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  headIdentityScopeForEntry
} from './worktree-head-identity-scope'

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: vi.fn() }
    isDestroyed(): boolean {
      return false
    }
  }
}))

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn()
}))

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  setWorktreeCatalogRemoteClientNotifier(null)
})

it('tells paired clients which worktree an index change touched', async () => {
  const listing = [
    {
      path: '/tmp/repo',
      head: 'a',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true
    },
    {
      path: '/tmp/feature',
      head: 'b',
      branch: 'refs/heads/feature',
      isBare: false,
      isMainWorktree: false
    }
  ]
  vi.mocked(listWorktrees).mockResolvedValue(listing)
  vi.mocked(listWorktreesStrict).mockResolvedValue(listing)
  // The harness store holds repo-1 at /tmp/repo.
  const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
  setWorktreeCatalogRemoteClientNotifier(runtime)
  await runtime.listManagedWorktrees('repo-1')
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))

  const headIdentityRefresh = createWorktreeHeadIdentityRefreshState()
  headIdentityRefresh.cache.entries.set('feature', {
    worktreePath: '/tmp/feature',
    head: 'b',
    branch: 'refs/heads/feature'
  })
  const watch: WorktreeBaseNotificationWatch = {
    key: 'git-common:/tmp/repo/.git',
    kind: 'git-common',
    path: '/tmp/repo/.git',
    repos: new Map(),
    mainWindow: new BrowserWindow(),
    notifyTimer: null,
    pendingStructureRepoIds: new Set(),
    pendingGitStatusRepoIds: new Set(),
    pendingHeadIdentityRepoIds: new Set(),
    pendingHeadIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
    pendingGitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE,
    headIdentityRefresh,
    disposed: false
  }
  vi.useFakeTimers()
  scheduleWorktreeBaseNotification(watch, {
    gitStatusRepoIds: ['repo-1'],
    gitStatusScope: headIdentityScopeForEntry('feature')
  })
  await vi.advanceTimersByTimeAsync(250)

  expect(events.filter((event) => event.type === 'gitStatusChanged')).toEqual([
    { type: 'gitStatusChanged', repoId: 'repo-1', worktreeIds: ['repo-1::/tmp/feature'] }
  ])
})
