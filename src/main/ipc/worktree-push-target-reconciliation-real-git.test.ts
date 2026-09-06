// Real-binary coverage for the pr-* remote reconciliation sweep (#17828): the mocked-exec suite
// proves the decision matrix, but not that `git remote -v`, `git config --get-regexp`, and
// `git for-each-ref` are parsed correctly against real Git output.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'
import { reconcileOrphanedPrRemotesWithExec } from './worktree-push-target-reconciliation'

const execFileAsync = promisify(execFile)

const REPO_ID = 'repo-1'
const FORK_REMOTE = 'pr-contributor-orca'

let scratchDir = ''
let repoPath = ''
let forkPath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

const execGit: GitRemoteExec = (args, cwd) => execFileAsync('git', args, { cwd })

function worktreeId(suffix: string): string {
  return `${REPO_ID}::${suffix}`
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: forkPath,
    remoteCreated: true,
    ...overrides
  }
}

function storeOf(entries: Record<string, GitPushTarget | undefined>): WorktreePushTargetStore {
  const meta: Record<string, WorktreeMeta> = {}
  for (const [id, pushTarget] of Object.entries(entries)) {
    meta[id] = { pushTarget } as unknown as WorktreeMeta
  }
  return { getAllWorktreeMeta: () => meta }
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/...
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-pr-remote-reconcile-')))
  repoPath = join(scratchDir, 'repo')
  forkPath = join(scratchDir, 'fork')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.name', 'Orca Test'], repoPath)
  await git(['config', 'user.email', 'orca@example.test'], repoPath)
  await git(['config', 'commit.gpgSign', 'false'], repoPath)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)

  // A second local "fork" repo the pr-* remote points at, so `remote add`/fetch behave normally.
  await git(['clone', '-q', repoPath, forkPath], scratchDir)
  await git(['config', 'user.name', 'Orca Test'], forkPath)
  await git(['config', 'user.email', 'orca@example.test'], forkPath)
  await git(['config', 'commit.gpgSign', 'false'], forkPath)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], forkPath)
  await git(['checkout', '-qb', 'contributor/fix'], forkPath)
  await writeFile(join(forkPath, 'fork.txt'), 'fork change\n')
  await git(['add', '-A'], forkPath)
  await git(['commit', '-qm', 'fork change'], forkPath)

  await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
  await git(
    [
      'fetch',
      FORK_REMOTE,
      `+refs/heads/contributor/fix:refs/remotes/${FORK_REMOTE}/contributor/fix`
    ],
    repoPath
  )
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('reconcileOrphanedPrRemotesWithExec against the real Git binary', () => {
  it('leaves a user-created remote alone: naming/URL shape is not proof of provenance', async () => {
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({}), // no worktree metadata anywhere claims this remote
      execGit,
      []
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
  })

  it('leaves the remote alone while a live worktree still references it', async () => {
    const worktreePath = join(scratchDir, 'wt-live')
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'contributor/fix-local'], repoPath)

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(worktreePath)]: forkTarget() }),
      execGit,
      [worktreePath]
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
  })

  it('leaves the remote alone while its branch still exists (preserve-on-delete kept alive)', async () => {
    await git(['branch', 'contributor/fix', `${FORK_REMOTE}/contributor/fix`], repoPath)
    await git(['config', `branch.contributor/fix.remote`, FORK_REMOTE], repoPath)

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(join(scratchDir, 'wt-gone'))]: forkTarget() }),
      execGit,
      [] // the worktree that created it is gone, but the branch it preserved is not
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
  })

  it('reclaims the remote once the branch that pinned it is deleted (path 2)', async () => {
    await git(['branch', 'contributor/fix', `${FORK_REMOTE}/contributor/fix`], repoPath)
    await git(['config', `branch.contributor/fix.remote`, FORK_REMOTE], repoPath)
    // Delete only the ref, leaving the config behind, exactly as `update-ref -d` alone would --
    // proving the sweep checks branch existence rather than trusting stale config.
    await rm(join(repoPath, '.git', 'refs', 'heads', 'contributor', 'fix'))

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(join(scratchDir, 'wt-gone'))]: forkTarget() }),
      execGit,
      []
    )
    expect(reclaimed).toEqual([FORK_REMOTE])
    await expect(git(['remote'], repoPath)).resolves.not.toContain(FORK_REMOTE)
  })

  it('reclaims a remote orphaned by a worktree removed outside Orca (path 3)', async () => {
    const worktreePath = join(scratchDir, 'wt-externally-removed')
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'contributor/fix-local-2'], repoPath)
    // Simulate a plain `git worktree remove` the user ran outside Orca: Orca's metadata for
    // that worktree is still sitting in the store (nothing told it to clean up), but the
    // worktree itself is gone.
    await git(['worktree', 'remove', '--force', worktreePath], repoPath)

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(worktreePath)]: forkTarget() }),
      execGit,
      [] // listWorktrees no longer reports it
    )
    expect(reclaimed).toEqual([FORK_REMOTE])
    await expect(git(['remote'], repoPath)).resolves.not.toContain(FORK_REMOTE)
  })
})
