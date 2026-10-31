import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'
import {
  configureCreatedWorktreePushTargetWithExec,
  prepareWorktreePushTargetWithExec
} from './worktree-push-target-setup'
import { resolveFetchTrackingRef } from '../../shared/git-branch-cleanup-fetch'
import { migrateForkRemoteRefspecsWithExec } from './worktree-push-target-refspec-migration'

const execFileAsync = promisify(execFile)
let isolatedGitEnv: NodeJS.ProcessEnv

const REPO_ID = 'repo-1'
const FORK_REMOTE = 'pr-contributor-orca'
const TRACKED_BRANCH = 'contributor/fix'
const OTHER_FORK_BRANCHES = Array.from({ length: 12 }, (_, i) => `contributor/unrelated-${i}`)

let scratchDir = ''
let repoPath = ''
let forkPath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: isolatedGitEnv })
  return stdout
}

const execGit: GitRemoteExec = (args, cwd) =>
  execFileAsync('git', args, { cwd, env: isolatedGitEnv })

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
  const home = join(scratchDir, 'home')
  await mkdir(home)
  isolatedGitEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'empty'),
    GIT_TERMINAL_PROMPT: '0'
  }
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

    await prepareWorktreePushTargetWithExec(execGit, repoPath, target)

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
    await prepareWorktreePushTargetWithExec(execGit, repoPath, target)
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
    await prepareWorktreePushTargetWithExec(execGit, repoPath, {
      remoteName: FORK_REMOTE,
      branchName: TRACKED_BRANCH,
      remoteUrl: forkPath
    })
    const secondBranch = OTHER_FORK_BRANCHES[0]!

    await prepareWorktreePushTargetWithExec(execGit, repoPath, {
      remoteName: FORK_REMOTE,
      branchName: secondBranch,
      remoteUrl: forkPath
    })

    await git(['fetch', FORK_REMOTE], repoPath)
    const refs = await trackedRefsUnder(FORK_REMOTE)
    expect(refs.sort()).toEqual(
      [`${FORK_REMOTE}/${TRACKED_BRANCH}`, `${FORK_REMOTE}/${secondBranch}`].sort()
    )
    expect(refs).toHaveLength(2)
  })
})

describe('migrateForkRemoteRefspecsWithExec against the real Git binary', () => {
  it.each(['ordinary', 'concurrent', 'symbolic'])(
    'narrows managed imports while preserving %s ref outcomes',
    async (mode) => {
      // Model legacy wide-fetch materialization.
      const forkBranchCount = (await git(['branch', '--format=%(refname:short)'], forkPath))
        .split(/\r?\n/)
        .filter(Boolean).length
      await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
      await git(['config', '--local', `remote.${FORK_REMOTE}.orca-created`, 'true'], repoPath)
      await git(['fetch', FORK_REMOTE], repoPath)
      const before = await trackedRefsUnder(FORK_REMOTE)
      // Newer Git auto-creates remote HEAD, shortened to the remote name; exclude that symref from branch counts.
      const headRef = FORK_REMOTE
      expect(before.filter((ref) => ref !== headRef).length).toBe(forkBranchCount)

      const victim = `refs/remotes/${FORK_REMOTE}/${OTHER_FORK_BRANCHES[0]}`
      const replacement = (await git(['rev-parse', 'HEAD'], repoPath)).trim()
      if (mode === 'symbolic') {
        await git(
          ['symbolic-ref', victim, `refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}`],
          repoPath
        )
      }
      const checked: GitRemoteExec = async (args, cwd) => {
        if (mode === 'concurrent' && args[0] === 'update-ref' && args[3] === victim) {
          await git(['update-ref', victim, replacement], cwd)
        }
        return execGit(args, cwd)
      }
      const migrated = await migrateForkRemoteRefspecsWithExec(
        repoPath,
        REPO_ID,
        storeOf({
          [worktreeId('/wt/a')]: {
            remoteName: FORK_REMOTE,
            branchName: TRACKED_BRANCH,
            remoteUrl: forkPath,
            remoteCreated: false
          }
        }),
        checked
      )

      expect(migrated).toEqual(mode === 'symbolic' ? [] : [FORK_REMOTE])
      const refspecs = (await git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath))
        .split(/\r?\n/)
        .filter(Boolean)
      expect(refspecs).toEqual(
        mode === 'symbolic'
          ? [`+refs/heads/*:refs/remotes/${FORK_REMOTE}/*`]
          : [`+refs/heads/${TRACKED_BRANCH}*:refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}*`]
      )
      // Pruning preserves remote HEAD; compare only branch refs across Git versions.
      const after = await trackedRefsUnder(FORK_REMOTE)
      expect(after.filter((ref) => ref !== headRef).sort()).toEqual(
        mode === 'symbolic'
          ? before.filter((ref) => ref !== headRef).sort()
          : [
              `${FORK_REMOTE}/${TRACKED_BRANCH}`,
              ...(mode === 'ordinary' ? [] : [`${FORK_REMOTE}/${OTHER_FORK_BRANCHES[0]}`])
            ].sort()
      )
      if (mode === 'concurrent') {
        expect((await git(['rev-parse', victim], repoPath)).trim()).toBe(replacement)
        await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, storeOf({}), execGit)
        await git(['remote', 'remove', FORK_REMOTE], repoPath)
        expect((await git(['rev-parse', victim], repoPath)).trim()).toBe(replacement)
      }
      if (mode === 'symbolic') {
        expect((await git(['symbolic-ref', victim], repoPath)).trim()).toBe(
          `refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}`
        )
      }
    }
  )

  it('clears the refspec of a wide pr-* remote with zero worktree-metadata trace, and prunes its refs', async () => {
    // External removal can erase both live-worktree and metadata ownership traces.
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    await git(['config', '--local', `remote.${FORK_REMOTE}.orca-created`, 'true'], repoPath)
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

it.each([
  'broad',
  'uncovered',
  'custom',
  'suffix',
  'internal',
  'multiple',
  'sibling',
  'sibling-negative',
  'excluded',
  'mirror',
  'collision',
  'cross-repo'
])('prepares safe native tracking for %s without replacing borrowed policy', async (shape) => {
  await git(['remote', 'add', 'manual', forkPath], repoPath)
  const source = `refs/heads/${TRACKED_BRANCH}`
  const destination =
    shape === 'custom'
      ? 'refs/private/*'
      : shape === 'suffix'
        ? 'refs/private/*-cache'
        : 'refs/remotes/manual/*'
  const spec =
    shape === 'internal'
      ? `+refs/heads/contributor/f*x:refs/remotes/manual/contributor/f*x`
      : shape === 'uncovered'
        ? '+refs/heads/main:refs/remotes/manual/main'
        : `+refs/heads/*:${destination}`
  await git(['config', '--replace-all', 'remote.manual.fetch', spec], repoPath)
  if (shape === 'multiple') {
    await git(
      ['config', '--add', 'remote.manual.fetch', '+refs/heads/*:refs/secondary/*'],
      repoPath
    )
  }
  if (shape === 'sibling') {
    await git(
      [
        'config',
        '--add',
        'remote.manual.fetch',
        '+refs/heads/deleted-sibling:refs/remotes/manual/deleted-sibling'
      ],
      repoPath
    )
  }
  if (shape === 'sibling-negative') {
    await git(['config', '--add', 'remote.manual.fetch', '^refs/heads/deleted-sibling'], repoPath)
  }
  if (shape === 'mirror') {
    await git(['config', 'remote.manual.mirror', 'true'], repoPath)
  }
  if (shape === 'excluded') {
    await git(['config', '--add', 'remote.manual.fetch', `^${source}`], repoPath)
  }
  if (shape === 'collision') {
    await git(
      [
        'config',
        '--replace-all',
        'remote.manual.fetch',
        `+refs/heads/secret:refs/remotes/manual/${TRACKED_BRANCH}-other`
      ],
      repoPath
    )
  }
  if (shape === 'cross-repo') {
    await git(['remote', 'add', 'different', join(scratchDir, 'different.git')], repoPath)
    await git(
      [
        'config',
        '--replace-all',
        'remote.different.fetch',
        `+${source}:refs/remotes/manual/${TRACKED_BRANCH}`
      ],
      repoPath
    )
  }
  const before = await git(['config', '--get-regexp', '^remote\\.manual\\.'], repoPath)
  const prepared = await prepareWorktreePushTargetWithExec(execGit, repoPath, {
    remoteName: 'requested',
    remoteUrl: forkPath,
    branchName: TRACKED_BRANCH
  })
  await configureCreatedWorktreePushTargetWithExec(
    execGit,
    repoPath,
    (await git(['branch', '--show-current'], repoPath)).trim(),
    prepared
  )
  const fallback = ['excluded', 'mirror', 'collision', 'cross-repo'].includes(shape)
  expect(prepared.remoteName).toBe(fallback ? 'requested' : 'manual')
  const after = await git(['config', '--get-regexp', '^remote\\.manual\\.'], repoPath)
  if (shape === 'uncovered') {
    expect(after).toContain(before.trim())
  } else {
    expect(after).toBe(before)
  }
  expect(await git(['config', '--get-all', 'remote.manual.fetch'], repoPath)).toContain(
    shape === 'collision' ? 'secret' : spec
  )
  expect(await git(['rev-parse', 'HEAD@{u}'], repoPath)).toBe(
    await git(['rev-parse', source], forkPath)
  )
  if (shape === 'multiple') {
    await expect(
      git(['rev-parse', '--verify', `refs/secondary/${TRACKED_BRANCH}`], repoPath)
    ).rejects.toThrow()
  }
})

it.each(['add-first', 'add-second', 'after-prune', 'drop'])(
  'retains required maps at a persisted %s interruption and converges on re-entry',
  async (phase) => {
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    await git(['config', `remote.${FORK_REMOTE}.orca-created`, 'true'], repoPath)
    await git(['fetch', FORK_REMOTE], repoPath)
    const branches = [TRACKED_BRANCH, OTHER_FORK_BRANCHES[0]!]
    const store = storeOf(
      Object.fromEntries(
        branches.map((branchName, i) => [
          worktreeId(`/saved-${i}`),
          { remoteName: FORK_REMOTE, remoteUrl: forkPath, branchName }
        ])
      )
    )
    const key = `remote.${FORK_REMOTE}.fetch`
    let adds = 0,
      interrupted = false
    const checked: GitRemoteExec = async (args, cwd) => {
      const adding = args[0] === 'config' && args[1] === '--add' && args[2] === key
      if (adding) {
        adds += 1
      }
      if (!interrupted && phase === 'after-prune' && args.includes('--unset-all')) {
        interrupted = true
        throw new Error('paused after prune')
      }
      const result = await execGit(args, cwd)
      if (
        !interrupted &&
        ((adding && adds === (phase === 'add-first' ? 1 : phase === 'add-second' ? 2 : -1)) ||
          (phase === 'drop' && args.includes('--unset-all')))
      ) {
        interrupted = true
        throw new Error('paused config write')
      }
      return result
    }
    expect(await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, checked)).toEqual([])
    expect(interrupted).toBe(true)
    const partial = (await git(['config', '--get-all', key], repoPath)).trim().split('\n')
    for (const branch of branches) {
      expect(resolveFetchTrackingRef(partial, `refs/heads/${branch}`)).toBe(
        `refs/remotes/${FORK_REMOTE}/${branch}`
      )
    }
    await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, execGit)
    expect((await git(['config', '--get-all', key], repoPath)).trim().split('\n').sort()).toEqual(
      branches
        .map((branch) => `+refs/heads/${branch}*:refs/remotes/${FORK_REMOTE}/${branch}*`)
        .sort()
    )
    for (const branch of branches) {
      expect(await git(['rev-parse', `refs/remotes/${FORK_REMOTE}/${branch}`], repoPath)).toBe(
        await git(['rev-parse', branch], forkPath)
      )
    }
    await expect(git(['fetch', FORK_REMOTE], repoPath)).resolves.toBeDefined()
  }
)

it.each(['empty', 'uncovered'])(
  'first actual branch use admits an alias instead of automatic %s expansion',
  async (shape) => {
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    const key = `remote.${FORK_REMOTE}.fetch`
    await git(['config', `remote.${FORK_REMOTE}.orca-created`, 'true'], repoPath)
    await git(['config', '--unset-all', key], repoPath)
    if (shape === 'uncovered') {
      await git(
        ['config', '--add', key, `+refs/heads/old*:refs/remotes/${FORK_REMOTE}/old*`],
        repoPath
      )
    }
    const sibling = `refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}-user`,
      oid = (await git(['rev-parse', 'HEAD'], repoPath)).trim()
    await git(['update-ref', sibling, oid], repoPath)
    await migrateForkRemoteRefspecsWithExec(
      repoPath,
      REPO_ID,
      storeOf({
        [worktreeId('/saved')]: {
          remoteName: FORK_REMOTE,
          remoteUrl: forkPath,
          branchName: TRACKED_BRANCH
        }
      }),
      execGit
    )
    const prepared = await prepareWorktreePushTargetWithExec(execGit, repoPath, {
      remoteName: FORK_REMOTE,
      remoteUrl: forkPath,
      branchName: TRACKED_BRANCH
    })
    expect(prepared.remoteName).toBe(`${FORK_REMOTE}-2`)
    await configureCreatedWorktreePushTargetWithExec(
      execGit,
      repoPath,
      (await git(['branch', '--show-current'], repoPath)).trim(),
      prepared
    )
    expect(await git(['rev-parse', 'HEAD@{u}'], repoPath)).toBe(
      await git(['rev-parse', TRACKED_BRANCH], forkPath)
    )
    expect((await git(['rev-parse', sibling], repoPath)).trim()).toBe(oid)
  }
)

it.each(['contract-prefixes', 'semantic-noop'])(
  'uses canonical stock proof for %s without normalizing raw no-ops',
  async (mode) => {
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    await git(['config', `remote.${FORK_REMOTE}.orca-created`, 'true'], repoPath)
    const key = `remote.${FORK_REMOTE}.fetch`,
      kept = `+refs/heads/${TRACKED_BRANCH}*:refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}*`
    await git(['config', '--replace-all', key, kept], repoPath)
    await git(
      [
        'config',
        '--add',
        key,
        mode === 'semantic-noop'
          ? kept
          : `+refs/heads/${OTHER_FORK_BRANCHES[0]}*:refs/remotes/${FORK_REMOTE}/${OTHER_FORK_BRANCHES[0]}*`
      ],
      repoPath
    )
    if (mode === 'semantic-noop') {
      await git(
        [
          'config',
          '--add',
          key,
          `+refs/heads/${TRACKED_BRANCH}:refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}`
        ],
        repoPath
      )
    }
    await git(['fetch', FORK_REMOTE], repoPath)
    const before = await git(['config', '--list', '-z'], repoPath)
    const rows = storeOf({
      [worktreeId('/saved')]: {
        remoteName: FORK_REMOTE,
        remoteUrl: forkPath,
        branchName: TRACKED_BRANCH
      }
    })
    expect(await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, rows, execGit)).toEqual(
      mode === 'semantic-noop' ? [] : [FORK_REMOTE]
    )
    if (mode === 'semantic-noop') {
      expect(await git(['config', '--list', '-z'], repoPath)).toBe(before)
    } else {
      expect(await git(['config', '--get-all', key], repoPath)).toBe(`${kept}\n`)
      await expect(
        git(
          ['rev-parse', '--verify', `refs/remotes/${FORK_REMOTE}/${OTHER_FORK_BRANCHES[0]}`],
          repoPath
        )
      ).rejects.toThrow()
    }
    expect(
      await git(['rev-parse', `refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}`], repoPath)
    ).toBe(await git(['rev-parse', TRACKED_BRANCH], forkPath))
  }
)
