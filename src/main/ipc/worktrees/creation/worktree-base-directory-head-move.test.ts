import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectLocalWorktreeBaseChanges } from './worktree-base-directory-change-collector'
import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import {
  createWorktreeHeadIdentityRefreshState,
  refreshWorktreeHeadIdentities
} from './worktree-head-identity-refresh'
import { EMPTY_HEAD_IDENTITY_SCOPE } from './worktree-head-identity-scope'

const REPO_ID = 'repo-1'
const tempDirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepoWithLinkedWorktree(): { commonDir: string; linkedPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-head-move-')))
  tempDirs.push(root)
  const repoPath = join(root, 'repo')
  const linkedPath = join(root, 'linked')
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath])
  for (const [key, value] of [
    ['user.email', 'test@example.com'],
    ['user.name', 'Test'],
    ['commit.gpgsign', 'false']
  ]) {
    git(repoPath, 'config', key, value)
  }
  git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'one')
  git(repoPath, 'worktree', 'add', '-q', '-b', 'feature', linkedPath)
  return { commonDir: join(repoPath, '.git'), linkedPath }
}

function createWatch(
  commonDir: string,
  runtimeEnvironmentActive = false
): WorktreeBaseNotificationWatch & { sent: { channel: string; payload: unknown }[] } {
  const sent: { channel: string; payload: unknown }[] = []
  return {
    key: `git-common:${commonDir}`,
    kind: 'git-common',
    path: commonDir,
    repos: new Map([[REPO_ID, { repoId: REPO_ID, repoName: 'repo', nestWorkspaces: false }]]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watcher only calls isDestroyed and webContents.send.
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
    } as never,
    notifyTimer: null,
    pendingStructureRepoIds: new Set(),
    pendingGitStatusRepoIds: new Set(),
    pendingHeadIdentityRepoIds: new Set(),
    pendingHeadMoveRepoIds: new Set(),
    pendingHeadIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
    pendingGitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE,
    headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
    isRuntimeEnvironmentActive: () => runtimeEnvironmentActive,
    disposed: false,
    sent
  }
}

async function flushLinkedHeadWrite(
  watch: ReturnType<typeof createWatch>,
  commonDir: string
): Promise<void> {
  scheduleWorktreeBaseNotification(
    watch,
    collectLocalWorktreeBaseChanges(watch, [
      { type: 'update', path: join(commonDir, 'worktrees', 'linked', 'HEAD') }
    ])
  )
  // The debounce starts the identity read synchronously, so both settle together.
  await vi.waitFor(() => {
    expect(watch.notifyTimer).toBeNull()
    expect(watch.headIdentityRefresh.inFlight).toBe(false)
  })
}

function channels(watch: ReturnType<typeof createWatch>): string[] {
  return watch.sent.map((entry) => entry.channel)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('linked HEAD-only watcher bursts', () => {
  it('patches the moved head without re-listing the local catalog', async () => {
    const { commonDir, linkedPath } = createRepoWithLinkedWorktree()
    const watch = createWatch(commonDir)
    await refreshWorktreeHeadIdentities(watch, watch.headIdentityRefresh, false)
    git(linkedPath, 'checkout', '-q', '--detach')
    git(linkedPath, 'commit', '-q', '--allow-empty', '-m', 'two')
    const movedHead = git(linkedPath, 'rev-parse', 'HEAD')

    await flushLinkedHeadWrite(watch, commonDir)

    await vi.waitFor(() =>
      expect(watch.sent).toContainEqual({
        channel: 'worktrees:headIdentitiesChanged',
        payload: {
          repoId: REPO_ID,
          identities: [{ worktreePath: linkedPath, head: movedHead, branch: null }]
        }
      })
    )
    expect(channels(watch)).toContain('worktrees:gitStatusMetadataChanged')
    expect(channels(watch)).not.toContain('worktrees:changed')
  })

  it('re-lists when the renderer ignores head identities under a runtime environment', async () => {
    const { commonDir, linkedPath } = createRepoWithLinkedWorktree()
    const watch = createWatch(commonDir, true)
    await refreshWorktreeHeadIdentities(watch, watch.headIdentityRefresh, false)
    git(linkedPath, 'commit', '-q', '--allow-empty', '-m', 'two')

    await flushLinkedHeadWrite(watch, commonDir)

    expect(channels(watch)).toContain('worktrees:changed')
    expect(channels(watch)).not.toContain('worktrees:headIdentitiesChanged')
  })

  it('falls back to a re-list when no baseline proves the move was published', async () => {
    const { commonDir, linkedPath } = createRepoWithLinkedWorktree()
    const watch = createWatch(commonDir)
    git(linkedPath, 'commit', '-q', '--allow-empty', '-m', 'two')

    await flushLinkedHeadWrite(watch, commonDir)

    await vi.waitFor(() => expect(channels(watch)).toContain('worktrees:changed'))
  })

  it('re-lists when the moved HEAD has no commit to publish', async () => {
    const { commonDir, linkedPath } = createRepoWithLinkedWorktree()
    const watch = createWatch(commonDir)
    await refreshWorktreeHeadIdentities(watch, watch.headIdentityRefresh, false)
    git(linkedPath, 'switch', '-q', '--orphan', 'scratch')

    await flushLinkedHeadWrite(watch, commonDir)

    await vi.waitFor(() => expect(channels(watch)).toContain('worktrees:changed'))
  })
})
