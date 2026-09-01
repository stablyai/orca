import { describe, expect, it, vi, type Mock } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'
import {
  _resetForkRemoteRefspecMigrationRateLimitForTests,
  migrateForkRemoteRefspecsWithExec
} from './worktree-push-target-refspec-migration'

type ExecMock = Mock<GitRemoteExec>

const REPO_PATH = '/repo-root'
const REPO_ID = 'repo-1'
const FORK_REMOTE = 'pr-contributor-orca'

function worktreeId(suffix: string): string {
  return `${REPO_ID}::${suffix}`
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: 'git@github.com:contributor/orca.git',
    remoteCreated: true,
    ...overrides
  }
}

function metaWith(pushTarget: GitPushTarget | undefined): WorktreeMeta {
  return { pushTarget } as unknown as WorktreeMeta
}

function storeOf(entries: Record<string, GitPushTarget | undefined>): WorktreePushTargetStore {
  const meta: Record<string, WorktreeMeta> = {}
  for (const [id, pushTarget] of Object.entries(entries)) {
    meta[id] = metaWith(pushTarget)
  }
  return { getAllWorktreeMeta: () => meta }
}

type ExecScript = {
  fetchByRemote?: Record<string, string[]>
  urlByRemote?: Record<string, string>
  branchConfig?: string
  trackingRefsByRemote?: Record<string, string[]>
  // Simulates #17842's reconciliation sweep concurrently `remote remove`-ing this
  // remote in between this migration's pre-write and post-write existence checks.
  removeUrlAfterFirstCheck?: Set<string>
  // Remotes `git remote` (bare list) reports on disk -- drives discovery of a `pr-*`
  // remote with zero worktree-metadata trace at all.
  remoteNames?: string[]
}

function makeExec(script: ExecScript = {}): ExecMock {
  const {
    fetchByRemote = {},
    urlByRemote = {},
    branchConfig = '',
    trackingRefsByRemote = {},
    removeUrlAfterFirstCheck = new Set<string>(),
    remoteNames = []
  } = script
  const urlCheckCountByRemote: Record<string, number> = {}
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: remoteNames.length ? `${remoteNames.join('\n')}\n` : '', stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--get' && args[2]!.endsWith('.url')) {
      const remoteName = args[2]!.slice('remote.'.length, -'.url'.length)
      urlCheckCountByRemote[remoteName] = (urlCheckCountByRemote[remoteName] ?? 0) + 1
      const concurrentlyRemoved =
        removeUrlAfterFirstCheck.has(remoteName) && urlCheckCountByRemote[remoteName]! > 1
      const url = concurrentlyRemoved ? undefined : urlByRemote[remoteName]
      if (!url) {
        throw new Error(`no such remote ${remoteName}`)
      }
      return { stdout: url, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--remove-section' && args[2]!.startsWith('remote.')) {
      const remoteName = args[2]!.slice('remote.'.length)
      delete fetchByRemote[remoteName]
      delete urlByRemote[remoteName]
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      return { stdout: branchConfig, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--get-all' && args[2]!.endsWith('.fetch')) {
      const remoteName = args[2]!.slice('remote.'.length, -'.fetch'.length)
      const values = fetchByRemote[remoteName] ?? []
      if (values.length === 0) {
        throw new Error('key not found')
      }
      return { stdout: `${values.join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--unset-all' && args[2]!.endsWith('.fetch')) {
      const remoteName = args[2]!.slice('remote.'.length, -'.fetch'.length)
      fetchByRemote[remoteName] = []
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--add' && args[2]!.endsWith('.fetch')) {
      const remoteName = args[2]!.slice('remote.'.length, -'.fetch'.length)
      fetchByRemote[remoteName] = [...(fetchByRemote[remoteName] ?? []), args[3]!]
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'config' && args[1]?.endsWith('.tagOpt')) {
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'for-each-ref') {
      const prefix = args[2]!
      const remoteName = prefix.replace('refs/remotes/', '').replace(/\/$/, '')
      const refs = trackingRefsByRemote[remoteName] ?? []
      return {
        stdout: refs.length ? `${refs.map((r) => `${prefix}${r}`).join('\n')}\n` : '',
        stderr: ''
      }
    }
    if (args[0] === 'update-ref' && args[1] === '-d') {
      const refname = args[2]!
      for (const [remoteName, refs] of Object.entries(trackingRefsByRemote)) {
        const prefix = `refs/remotes/${remoteName}/`
        if (refname.startsWith(prefix)) {
          trackingRefsByRemote[remoteName] = refs.filter((r) => `${prefix}${r}` !== refname)
        }
      }
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

describe('migrateForkRemoteRefspecsWithExec', () => {
  it('narrows a wide-refspec remote to the known branch and deletes the strays left by the old wide fetch', async () => {
    const trackingRefsByRemote = {
      [FORK_REMOTE]: ['contributor/fix', 'contributor/unrelated-1', 'master']
    }
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: { [FORK_REMOTE]: ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] },
      trackingRefsByRemote
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget() }),
      exec
    )

    expect(migrated).toEqual([FORK_REMOTE])
    expect(exec.mock.calls).toContainEqual([
      [
        'config',
        '--add',
        `remote.${FORK_REMOTE}.fetch`,
        '+refs/heads/contributor/fix*:refs/remotes/pr-contributor-orca/contributor/fix*'
      ],
      REPO_PATH
    ])
    // `fetch --prune` cannot reclaim strays under a narrow refspec (verified against real
    // git); the migration must delete them directly instead.
    expect(exec.mock.calls.some(([args]) => args[0] === 'fetch' && args[1] === '--prune')).toBe(
      false
    )
    expect(trackingRefsByRemote[FORK_REMOTE]).toEqual(['contributor/fix'])
  })

  it('unions branches from multiple worktrees sharing the same fork remote', async () => {
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: { [FORK_REMOTE]: ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] }
    })

    await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({
        [worktreeId('/wt/a')]: forkTarget({ branchName: 'branch-a' }),
        [worktreeId('/wt/b')]: forkTarget({ branchName: 'branch-b', remoteCreated: false })
      }),
      exec
    )

    const addedRefspecs = exec.mock.calls
      .filter(([args]) => args[0] === 'config' && args[1] === '--add')
      .map(([args]) => args[3])
    expect(addedRefspecs).toEqual(
      expect.arrayContaining([
        '+refs/heads/branch-a*:refs/remotes/pr-contributor-orca/branch-a*',
        '+refs/heads/branch-b*:refs/remotes/pr-contributor-orca/branch-b*'
      ])
    )
  })

  it('skips a remote with no provenance evidence (no metadata entry has remoteCreated: true)', async () => {
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: { [FORK_REMOTE]: ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] }
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget({ remoteCreated: false }) }),
      exec
    )

    expect(migrated).toEqual([])
    expect(exec.mock.calls.some(([args]) => args[1] === '--unset-all')).toBe(false)
  })

  it('never touches origin or upstream even with malformed metadata', async () => {
    const exec = makeExec({ urlByRemote: { origin: 'git@github.com:stablyai/orca.git\n' } })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget({ remoteName: 'origin' }) }),
      exec
    )

    expect(migrated).toEqual([])
  })

  it('scopes provenance to the same repo (remotes are repo-local)', async () => {
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: { [FORK_REMOTE]: ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] }
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ 'repo-2::/wt/other-repo': forkTarget() }),
      exec
    )

    expect(migrated).toEqual([])
  })

  it('skips (does not re-fetch) a remote that is already narrow', async () => {
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: {
        [FORK_REMOTE]: [
          '+refs/heads/contributor/fix*:refs/remotes/pr-contributor-orca/contributor/fix*'
        ]
      }
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget() }),
      exec
    )

    expect(migrated).toEqual([])
    expect(exec.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false)
  })

  it('abandons and cleans up a remote reclaimed concurrently by #17842 reconciliation mid-migration', async () => {
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: { [FORK_REMOTE]: ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] },
      removeUrlAfterFirstCheck: new Set([FORK_REMOTE])
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget() }),
      exec
    )

    // Not reported as migrated -- reconciliation won the race, so this sweep backs off.
    expect(migrated).toEqual([])
    expect(
      exec.mock.calls.some(
        ([args]) =>
          args[0] === 'config' &&
          args[1] === '--remove-section' &&
          args[2] === `remote.${FORK_REMOTE}`
      )
    ).toBe(true)
    // No fetch --prune-equivalent local ref deletion ran for a remote that's already gone.
    expect(exec.mock.calls.some(([args]) => args[0] === 'update-ref')).toBe(false)
  })

  it('clears the fetch refspec of a wide pr-* remote with zero worktree-metadata trace at all', async () => {
    const ORPHAN_REMOTE = 'pr-ghost-orca'
    const trackingRefsByRemote = { [ORPHAN_REMOTE]: ['some-branch', 'another-branch'] }
    const exec = makeExec({
      remoteNames: [ORPHAN_REMOTE],
      urlByRemote: { [ORPHAN_REMOTE]: 'git@github.com:ghost/orca.git\n' },
      fetchByRemote: { [ORPHAN_REMOTE]: ['+refs/heads/*:refs/remotes/pr-ghost-orca/*'] },
      trackingRefsByRemote
    })

    // No worktree metadata references this remote at all (worktree removed outside
    // preserve-on-delete, metadata purged) -- only discoverable via `git remote`.
    const migrated = await migrateForkRemoteRefspecsWithExec(REPO_PATH, REPO_ID, storeOf({}), exec)

    expect(migrated).toEqual([ORPHAN_REMOTE])
    expect(exec.mock.calls).toContainEqual([
      ['config', '--unset-all', `remote.${ORPHAN_REMOTE}.fetch`],
      REPO_PATH
    ])
    // No branch to narrow to, so it never adds a replacement refspec.
    expect(exec.mock.calls.some(([args]) => args[0] === 'config' && args[1] === '--add')).toBe(
      false
    )
    // Every stray tracking ref is pruned, same as the narrowing path.
    expect(trackingRefsByRemote[ORPHAN_REMOTE]).toEqual([])
  })

  it('leaves a zero-provenance pr-* remote alone if its refspec is not the stock wide default', async () => {
    const CUSTOM_REMOTE = 'pr-custom-orca'
    const exec = makeExec({
      remoteNames: [CUSTOM_REMOTE],
      urlByRemote: { [CUSTOM_REMOTE]: 'git@github.com:custom/orca.git\n' },
      fetchByRemote: {
        [CUSTOM_REMOTE]: ['+refs/heads/some-branch:refs/remotes/pr-custom-orca/some-branch']
      }
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(REPO_PATH, REPO_ID, storeOf({}), exec)

    expect(migrated).toEqual([])
    expect(exec.mock.calls.some(([args]) => args[1] === '--unset-all')).toBe(false)
  })

  it('never discovers a non-pr-prefixed remote through the bare listing, even if wide', async () => {
    const exec = makeExec({
      remoteNames: ['some-other-remote'],
      urlByRemote: { 'some-other-remote': 'git@github.com:someone/else.git\n' },
      fetchByRemote: { 'some-other-remote': ['+refs/heads/*:refs/remotes/some-other-remote/*'] }
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(REPO_PATH, REPO_ID, storeOf({}), exec)

    expect(migrated).toEqual([])
    expect(exec.mock.calls.some(([args]) => args[1] === '--unset-all')).toBe(false)
  })

  it('also narrows branches only referenced by surviving branch.*.remote config (no metadata left)', async () => {
    const exec = makeExec({
      urlByRemote: { [FORK_REMOTE]: 'git@github.com:contributor/orca.git\n' },
      fetchByRemote: { [FORK_REMOTE]: ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] },
      branchConfig: `branch.contributor/preserved.remote ${FORK_REMOTE}`
    })

    const migrated = await migrateForkRemoteRefspecsWithExec(
      REPO_PATH,
      REPO_ID,
      // Only proof of Orca provenance; the branch itself comes from local config.
      storeOf({ [worktreeId('/wt/gone')]: forkTarget({ branchName: 'contributor/fix' }) }),
      exec
    )

    expect(migrated).toEqual([FORK_REMOTE])
    const addedRefspecs = exec.mock.calls
      .filter(([args]) => args[0] === 'config' && args[1] === '--add')
      .map(([args]) => args[3])
    expect(addedRefspecs).toEqual(
      expect.arrayContaining([
        '+refs/heads/contributor/preserved*:refs/remotes/pr-contributor-orca/contributor/preserved*'
      ])
    )
  })
})

describe('fork remote refspec migration rate limiting', () => {
  it('exposes a test reset so repeated test runs are not affected by prior cooldowns', () => {
    expect(() => _resetForkRemoteRefspecMigrationRateLimitForTests()).not.toThrow()
  })
})
