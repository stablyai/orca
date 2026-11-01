import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'
import { prepareWorktreePushTargetWithExec } from './worktree-push-target-setup'
import { migrateForkRemoteRefspecsWithExec } from './worktree-push-target-refspec-migration'

const execFileAsync = promisify(execFile)

const REPO_ID = 'repo-1'
const FORK_REMOTE = 'pr-contributor-orca'
const TRACKED_BRANCH = 'contributor/fix'
const OTHER_FORK_BRANCHES = Array.from({ length: 12 }, (_, i) => `contributor/unrelated-${i}`)

let scratchDir = ''
let repoPath = ''
let forkPath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

const execGit: GitRemoteExec = (args, cwd) => execFileAsync('git', args, { cwd })

async function setIdentity(cwd: string): Promise<void> {
  await git(['config', 'user.name', 'Orca Test'], cwd)
  await git(['config', 'user.email', 'orca@example.test'], cwd)
  await git(['config', 'commit.gpgSign', 'false'], cwd)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], cwd)
}

async function trackedRefsUnder(remoteName: string): Promise<string[]> {
  const stdout = await git(
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}/`],
    repoPath
  )
  return stdout.split(/\r?\n/).filter(Boolean)
}

function worktreeId(suffix: string): string {
  return `${REPO_ID}::${suffix}`
}

function storeOf(entries: Record<string, GitPushTarget | undefined>): WorktreePushTargetStore {
  const meta: Record<string, WorktreeMeta> = {}
  for (const [id, pushTarget] of Object.entries(entries)) {
    meta[id] = { pushTarget } as unknown as WorktreeMeta
  }
  return { getAllWorktreeMeta: () => meta }
}

beforeEach(async () => {
  // macOS temp aliases must match Git's canonical paths.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-fork-refspec-')))
  repoPath = join(scratchDir, 'repo')
  forkPath = join(scratchDir, 'fork')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await setIdentity(repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)

  await git(['clone', '-q', repoPath, forkPath], scratchDir)
  await setIdentity(forkPath)
  for (const branch of [TRACKED_BRANCH, ...OTHER_FORK_BRANCHES]) {
    await git(['checkout', '-qb', branch], forkPath)
    await writeFile(join(forkPath, `${branch.replace(/\//g, '-')}.txt`), 'x\n')
    await git(['add', '-A'], forkPath)
    await git(['commit', '-qm', branch], forkPath)
  }
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('minting a fork remote against the real Git binary (#17828)', () => {
  it('caps the remote at exactly one fetch refspec, and a plain `git fetch` imports only that branch', async () => {
    const target: GitPushTarget = {
      remoteName: FORK_REMOTE,
      branchName: TRACKED_BRANCH,
      remoteUrl: forkPath
    }

    await prepareWorktreePushTargetWithExec(execGit, repoPath, target, () => false)

    const refspecs = (await git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath))
      .split(/\r?\n/)
      .filter(Boolean)
    expect(refspecs).toEqual([
      `+refs/heads/${TRACKED_BRANCH}*:refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}*`
    ])
    await expect(
      git(['config', '--get', `remote.${FORK_REMOTE}.tagOpt`], repoPath)
    ).resolves.toContain('--no-tags')

    // Plain fetch must retain only requested branches even when the fork has many others.
    await git(['fetch', FORK_REMOTE], repoPath)
    await expect(trackedRefsUnder(FORK_REMOTE)).resolves.toEqual([
      `${FORK_REMOTE}/${TRACKED_BRANCH}`
    ])
  })

  it('a bare `git fetch` (branch-scoped upstream, no remote arg) survives the tracked branch being deleted upstream', async () => {
    const target: GitPushTarget = {
      remoteName: FORK_REMOTE,
      branchName: TRACKED_BRANCH,
      remoteUrl: forkPath
    }
    await prepareWorktreePushTargetWithExec(execGit, repoPath, target, () => false)
    // Bare fetch follows branch.remote to the fork; test the agent/user command shape too.
    await git(['checkout', '-qb', 'local-branch', `${FORK_REMOTE}/${TRACKED_BRANCH}`], repoPath)
    await git(
      ['branch', '--set-upstream-to', `${FORK_REMOTE}/${TRACKED_BRANCH}`, 'local-branch'],
      repoPath
    )

    await git(['checkout', '-q', OTHER_FORK_BRANCHES[0]!], forkPath)
    await git(['branch', '-D', TRACKED_BRANCH], forkPath)

    // Trailing-* refspecs let ordinary fetch tolerate deletion of the tracked branch.
    await expect(git(['fetch'], repoPath)).resolves.toBeDefined()
    await git(['fetch', '--prune'], repoPath)
    await expect(trackedRefsUnder(FORK_REMOTE)).resolves.toEqual([])
  })

  it('widens rather than replaces when a second worktree reuses the remote for another branch', async () => {
    await prepareWorktreePushTargetWithExec(
      execGit,
      repoPath,
      { remoteName: FORK_REMOTE, branchName: TRACKED_BRANCH, remoteUrl: forkPath },
      () => false
    )
    const secondBranch = OTHER_FORK_BRANCHES[0]!

    await prepareWorktreePushTargetWithExec(
      execGit,
      repoPath,
      { remoteName: FORK_REMOTE, branchName: secondBranch, remoteUrl: forkPath },
      () => true
    )

    await git(['fetch', FORK_REMOTE], repoPath)
    const refs = await trackedRefsUnder(FORK_REMOTE)
    expect(refs.sort()).toEqual(
      [`${FORK_REMOTE}/${TRACKED_BRANCH}`, `${FORK_REMOTE}/${secondBranch}`].sort()
    )
    expect(refs).toHaveLength(2)
  })
})

describe('migrateForkRemoteRefspecsWithExec against the real Git binary', () => {
  it('narrows a pre-existing wide-refspec remote and prunes the strays it already fetched', async () => {
    // Model legacy wide-fetch materialization.
    const forkBranchCount = (await git(['branch', '--format=%(refname:short)'], forkPath))
      .split(/\r?\n/)
      .filter(Boolean).length
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    await git(['fetch', FORK_REMOTE], repoPath)
    const before = await trackedRefsUnder(FORK_REMOTE)
    // Newer Git auto-creates remote HEAD, shortened to the remote name; exclude that symref from branch counts.
    const headRef = FORK_REMOTE
    expect(before.filter((ref) => ref !== headRef).length).toBe(forkBranchCount)

    const migrated = await migrateForkRemoteRefspecsWithExec(
      repoPath,
      REPO_ID,
      storeOf({
        [worktreeId('/wt/a')]: {
          remoteName: FORK_REMOTE,
          branchName: TRACKED_BRANCH,
          remoteUrl: forkPath,
          remoteCreated: true
        }
      }),
      execGit
    )

    expect(migrated).toEqual([FORK_REMOTE])
    const refspecs = (await git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath))
      .split(/\r?\n/)
      .filter(Boolean)
    expect(refspecs).toEqual([
      `+refs/heads/${TRACKED_BRANCH}*:refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}*`
    ])
    // Pruning preserves remote HEAD; compare only branch refs across Git versions.
    const after = await trackedRefsUnder(FORK_REMOTE)
    expect(after.filter((ref) => ref !== headRef)).toEqual([`${FORK_REMOTE}/${TRACKED_BRANCH}`])
  })

  it('clears the refspec of a wide pr-* remote with zero worktree-metadata trace, and prunes its refs', async () => {
    // External removal can erase both live-worktree and metadata ownership traces.
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    await git(['fetch', FORK_REMOTE], repoPath)
    const before = await trackedRefsUnder(FORK_REMOTE)
    expect(before.length).toBeGreaterThan(1)

    const migrated = await migrateForkRemoteRefspecsWithExec(
      repoPath,
      REPO_ID,
      storeOf({}),
      execGit
    )

    expect(migrated).toEqual([FORK_REMOTE])
    await expect(
      git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath)
    ).rejects.toThrow()
    // Ref migration preserves the remote for pushes while disabling unpinned fetch imports.
    await expect(
      git(['config', '--get', `remote.${FORK_REMOTE}.url`], repoPath)
    ).resolves.toContain(forkPath)
    await git(['fetch', FORK_REMOTE], repoPath)
    await expect(trackedRefsUnder(FORK_REMOTE)).resolves.toEqual([])
  })
})
