import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { collectLocalWorktreeBaseChanges } from './worktree-base-directory-change-collector'
import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import { createWorktreeHeadIdentityRefreshState } from './worktree-head-identity-refresh'
import { EMPTY_HEAD_IDENTITY_SCOPE } from './worktree-head-identity-scope'
import { notifyWorktreeGitStatusMetadataChanged } from './worktree-remote'

vi.mock('./worktree-remote', () => ({
  notifyWorktreeGitStatusMetadataChanged: vi.fn(),
  notifyWorktreeHeadIdentitiesChanged: vi.fn()
}))

vi.mock('./watched-worktree-catalog-notification', () => ({
  notifyWatchedWorktreeCatalogChanged: vi.fn()
}))

const COMMON_DIR = join('/repos', 'project', '.git')
const PRIMARY_PATH = join('/repos', 'project')
// The admin dir name need not match the checkout folder name.
const ACTIVE_PATH = join('/work', 'feature')
const SIBLING_PATH = join('/work', 'other')
const HEAD = 'a'.repeat(40)

function makeWatch(connectionId?: string): WorktreeBaseNotificationWatch {
  const headIdentityRefresh = createWorktreeHeadIdentityRefreshState()
  headIdentityRefresh.cache.primary = { worktreePath: PRIMARY_PATH, head: HEAD, branch: null }
  headIdentityRefresh.cache.entries.set('Feature1', {
    worktreePath: ACTIVE_PATH,
    head: HEAD,
    branch: null
  })
  headIdentityRefresh.cache.entries.set('other', {
    worktreePath: SIBLING_PATH,
    head: HEAD,
    branch: null
  })
  return {
    key: 'git-common:local',
    kind: 'git-common',
    path: COMMON_DIR,
    ...(connectionId ? { connectionId } : {}),
    repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: notifications only call isDestroyed.
    mainWindow: { isDestroyed: () => false } as never,
    notifyTimer: null,
    pendingStructureRepoIds: new Set(),
    pendingGitStatusRepoIds: new Set(),
    pendingHeadIdentityRepoIds: new Set(),
    pendingHeadIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
    pendingGitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE,
    headIdentityRefresh,
    disposed: false
  }
}

function update(...parts: string[]): { type: 'update'; path: string } {
  return { type: 'update', path: join(COMMON_DIR, ...parts) }
}

async function flush(watch: WorktreeBaseNotificationWatch, paths: string[][]): Promise<void> {
  scheduleWorktreeBaseNotification(
    watch,
    collectLocalWorktreeBaseChanges(
      watch,
      paths.map((parts) => update(...parts))
    )
  )
  await vi.advanceTimersByTimeAsync(300)
}

describe('scheduleWorktreeBaseNotification git status attribution', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(notifyWorktreeGitStatusMetadataChanged).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the checkout behind a linked index write via the admin-dir memo', async () => {
    await flush(makeWatch(), [['worktrees', 'other', 'index']])
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      [SIBLING_PATH]
    )
  })

  it('folds admin-dir case and unions every checkout in one burst', async () => {
    await flush(makeWatch(), [
      ['worktrees', 'feature1', 'index'],
      ['worktrees', 'other', 'logs', 'HEAD'],
      ['index']
    ])
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      [PRIMARY_PATH, ACTIVE_PATH, SIBLING_PATH]
    )
  })

  it('leaves the signal unattributed when any part of the burst cannot be attributed', async () => {
    const cases: string[][][] = [
      // Admin dir the memo has not resolved yet (e.g. just added).
      [['worktrees', 'unknown', 'index']],
      // Shared config can change any checkout's upstream.
      [['worktrees', 'other', 'index'], ['config']]
    ]
    for (const paths of cases) {
      vi.mocked(notifyWorktreeGitStatusMetadataChanged).mockClear()
      await flush(makeWatch(), paths)
      expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(
        expect.anything(),
        'repo-1',
        null
      )
    }
  })

  it('leaves bound upstream ref writes unattributed so the active checkout refreshes', async () => {
    const watch = makeWatch()
    const refPath = join(COMMON_DIR, 'refs', 'remotes', 'origin', 'feature')
    watch.gitStatusRefPaths = new Set([refPath])
    scheduleWorktreeBaseNotification(
      watch,
      collectLocalWorktreeBaseChanges(watch, [{ type: 'update', path: refPath }])
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      null
    )
  })

  it('leaves callers that state no scope (overflow, watcher error) unattributed', async () => {
    const watch = makeWatch()
    scheduleWorktreeBaseNotification(watch, { gitStatusRepoIds: ['repo-1'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      null
    )
  })

  it('never attributes SSH watches, which keep no local head memo', async () => {
    await flush(makeWatch('ssh-1'), [['worktrees', 'other', 'index']])
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      null
    )
  })
})
