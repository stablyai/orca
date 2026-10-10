// Real-binary coverage for #17828: the mocked-exec suites in
// `worktree-push-target-setup.test.ts` / `worktree-push-target-refspec-migration.test.ts`
// prove the decision logic, but not that real `git remote add -t/--no-tags`, a plain
// `git fetch <remote>`, and `git config --get-all/--unset-all/--add` behave the way this
// fix assumes. In particular this proves the core claim of the fix: a minted remote never
// imports more than the branch(es) Orca asked for, even from a fork with many branches.
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
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/...
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-fork-refspec-')))
  repoPath = join(scratchDir, 'repo')
  forkPath = join(scratchDir, 'fork')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await setIdentity(repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)

  // A large fork: the tracked PR branch plus a dozen unrelated branches, simulating the
  // 1000+-branch forks the issue describes (scaled down for test speed).
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

    // The critical claim: a later plain `git fetch <remote>` (no explicit refspec) --
    // exactly what Orca's own Fetch action and any agent/user command run -- must not
    // import the fork's other dozen branches.
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
    // Mirrors `configureCreatedWorktreePushTargetWithExec`: local branch tracks the fork
    // remote, so a *bare* `git fetch` (the shape an agent running raw git actually types)
    // resolves to this remote via `branch.<name>.remote` -- not `origin`.
    await git(['checkout', '-qb', 'local-branch', `${FORK_REMOTE}/${TRACKED_BRANCH}`], repoPath)
    await git(
      ['branch', '--set-upstream-to', `${FORK_REMOTE}/${TRACKED_BRANCH}`, 'local-branch'],
      repoPath
    )

    // Contributor deletes the branch after the PR merges/closes (checkout any other
    // branch first -- the fork's actual default-branch name isn't relevant here).
    await git(['checkout', '-q', OTHER_FORK_BRANCHES[0]!], forkPath)
    await git(['branch', '-D', TRACKED_BRANCH], forkPath)

    // Before this fix's trailing-`*` refspec, this exact command hard-failed with
    // "couldn't find remote ref" -- degrading a common agent/user action into a fatal error.
    await expect(git(['fetch'], repoPath)).resolves.toBeDefined()
    // And `--prune` (Orca's own Fetch action) correctly reclaims the now-dead ref.
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
    // Only the two branches Orca actually asked for -- not the other ten.
    expect(refs).toHaveLength(2)
  })
})

describe('migrateForkRemoteRefspecsWithExec against the real Git binary', () => {
  it('narrows a pre-existing wide-refspec remote and prunes the strays it already fetched', async () => {
    // Simulate a remote minted before the #17828 fix: bare `remote add`, full fetch.
    const forkBranchCount = (await git(['branch', '--format=%(refname:short)'], forkPath))
      .split(/\r?\n/)
      .filter(Boolean).length
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    await git(['fetch', FORK_REMOTE], repoPath)
    const before = await trackedRefsUnder(FORK_REMOTE)
    // Every fork branch imported (tracked branch + unrelated ones + the fork's default branch).
    // Git >= 2.44's `followRemoteHEAD` auto-creates `refs/remotes/<name>/HEAD` on a fetch
    // matching the full wildcard refspec (verified: absent on 2.44, present on 2.55) --
    // excluded here since it isn't a branch this test (or the migration) cares about.
    // `%(refname:short)` shortens the remote's own HEAD symref to just the remote name
    // (no `/HEAD` suffix) -- verified against real git.
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
    // `pruneUntrackedForkRemoteRefs` deliberately never deletes `HEAD` (see its docstring),
    // so a `HEAD` symref this git version auto-created above legitimately survives pruning --
    // assert on the branch refs only, same exclusion as above.
    const after = await trackedRefsUnder(FORK_REMOTE)
    expect(after.filter((ref) => ref !== headRef)).toEqual([`${FORK_REMOTE}/${TRACKED_BRANCH}`])
  })

  it('clears the refspec of a wide pr-* remote with zero worktree-metadata trace, and prunes its refs', async () => {
    // Simulates a remote whose worktree was removed outside preserve-on-delete: no live
    // worktree, and no surviving metadata entry either -- the store knows nothing about it.
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
    // The remote itself survives (only #17842's reconciliation removes remotes outright),
    // and stays pushable -- just imports nothing on a subsequent plain fetch.
    await expect(
      git(['config', '--get', `remote.${FORK_REMOTE}.url`], repoPath)
    ).resolves.toContain(forkPath)
    await git(['fetch', FORK_REMOTE], repoPath)
    await expect(trackedRefsUnder(FORK_REMOTE)).resolves.toEqual([])
  })
})
