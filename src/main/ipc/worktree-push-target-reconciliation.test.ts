import { describe, expect, it, vi, type Mock } from 'vitest'
import { validateGitExecArgs } from '../../relay/git-exec-validator'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'
import {
  _resetPrRemoteReconciliationRateLimitForTests,
  isOrcaGeneratedPrRemoteName,
  reconcileOrphanedPrRemotesWithExec
} from './worktree-push-target-reconciliation'

type ExecMock = Mock<GitRemoteExec>

const REPO_PATH = '/repo-root'
const REPO_ID = 'repo-1'
const FORK_URL = 'git@github.com:contributor/orca.git'
const FORK_REMOTE = 'pr-contributor-orca'

function worktreeId(suffix: string): string {
  return `${REPO_ID}::${suffix}`
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: FORK_URL,
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
  remotes?: string
  branchConfig?: string
  localBranches?: string
}

function makeExec(script: ExecScript = {}): ExecMock {
  const { remotes = '', branchConfig = '', localBranches = '' } = script
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === '-v') {
      return { stdout: remotes, stderr: '' }
    }
    if (args[0] === 'config') {
      return { stdout: branchConfig, stderr: '' }
    }
    if (args[0] === 'for-each-ref') {
      return { stdout: localBranches, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function remoteLines(entries: { name: string; url: string }[]): string {
  return entries
    .flatMap(({ name, url }) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join('\n')
}

function removeCalls(exec: ExecMock): string[][] {
  return exec.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === 'remote' && args[1] === 'remove')
}

describe('isOrcaGeneratedPrRemoteName', () => {
  it('matches Orca-generated names, including disambiguated ones', () => {
    expect(isOrcaGeneratedPrRemoteName('pr-head')).toBe(true)
    expect(isOrcaGeneratedPrRemoteName('pr-contributor-orca')).toBe(true)
    expect(isOrcaGeneratedPrRemoteName('pr-head-2')).toBe(true)
    expect(isOrcaGeneratedPrRemoteName('pr-contributor-orca-3')).toBe(true)
  })

  it('does not match unrelated remote names', () => {
    expect(isOrcaGeneratedPrRemoteName('origin')).toBe(false)
    expect(isOrcaGeneratedPrRemoteName('upstream')).toBe(false)
    expect(isOrcaGeneratedPrRemoteName('project-remote')).toBe(false)
  })
})

describe('reconcileOrphanedPrRemotesWithExec', () => {
  it('leaves a remote alone when no worktree metadata ever proves Orca created it (user-created, ambiguous)', async () => {
    // Same naming shape a user could coincidentally pick; no pushTarget anywhere claims it.
    const exec = makeExec({ remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]) })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({}),
      exec,
      []
    )
    expect(reclaimed).toEqual([])
    expect(removeCalls(exec)).toEqual([])
  })

  it('leaves a remote alone that is not shaped like an Orca-generated pr-* remote', async () => {
    const exec = makeExec({
      remotes: remoteLines([{ name: 'my-fork', url: FORK_URL }])
    })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: { ...forkTarget(), remoteName: 'my-fork' } }),
      exec,
      []
    )
    expect(reclaimed).toEqual([])
    expect(removeCalls(exec)).toEqual([])
  })

  it('leaves a remote alone that a live worktree still references (path guard)', async () => {
    const exec = makeExec({ remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]) })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget() }),
      exec,
      ['/wt/a']
    )
    expect(reclaimed).toEqual([])
    expect(removeCalls(exec)).toEqual([])
  })

  it('leaves a remote alone that is referenced by an existing branch (path 2, branch still kept)', async () => {
    const exec = makeExec({
      remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]),
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`,
      localBranches: 'contributor/fix\nmain'
    })
    // Metadata for the worktree that created it is gone, but the branch it preserved lives on.
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/gone')]: forkTarget() }),
      exec,
      []
    )
    expect(reclaimed).toEqual([])
    expect(removeCalls(exec)).toEqual([])
  })

  it('reclaims a remote whose protecting branch config is stale (path 2, branch since deleted)', async () => {
    const exec = makeExec({
      remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]),
      // Config line survives even though `contributor/fix` no longer exists.
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`,
      localBranches: 'main'
    })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/gone')]: forkTarget() }),
      exec,
      []
    )
    expect(reclaimed).toEqual([FORK_REMOTE])
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('reclaims a remote left behind by a worktree removed outside Orca (path 3)', async () => {
    const exec = makeExec({ remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]) })
    // Metadata still records the (now-vanished) worktree's Orca-created pushTarget.
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/gone')]: forkTarget() }),
      exec,
      [] // no live worktrees at all
    )
    expect(reclaimed).toEqual([FORK_REMOTE])
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('reclaims a remote even when the only referencing metadata lacks remoteCreated, as long as another entry proves provenance (path 1)', async () => {
    const exec = makeExec({ remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]) })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({
        // The worktree whose removal originally bailed (legacy metadata, no remoteCreated flag)...
        [worktreeId('/wt/legacy')]: forkTarget({ remoteCreated: false }),
        // ...but a sibling that reused the remote correctly inherited ownership, and is also gone.
        [worktreeId('/wt/sibling-gone')]: forkTarget({ remoteCreated: true })
      }),
      exec,
      []
    )
    expect(reclaimed).toEqual([FORK_REMOTE])
  })

  it('never touches origin or upstream even if metadata is malformed', async () => {
    const exec = makeExec({
      remotes: remoteLines([
        { name: 'origin', url: FORK_URL },
        { name: 'upstream', url: FORK_URL }
      ])
    })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/a')]: forkTarget({ remoteName: 'origin' }) }),
      exec,
      []
    )
    expect(reclaimed).toEqual([])
    expect(removeCalls(exec)).toEqual([])
  })

  it('scopes provenance and liveness to the same repo (remotes are repo-local)', async () => {
    const exec = makeExec({ remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]) })
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ 'repo-2::/wt/other-repo': forkTarget() }),
      exec,
      []
    )
    expect(reclaimed).toEqual([])
  })

  it('sends only argv the relay accepts, so the sweep is not silently skipped over SSH', async () => {
    // Exercise every branch (config probe, for-each-ref probe, and the reclaim itself).
    const exec = makeExec({
      remotes: remoteLines([{ name: FORK_REMOTE, url: FORK_URL }]),
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`,
      localBranches: 'main'
    })
    await reconcileOrphanedPrRemotesWithExec(
      REPO_PATH,
      REPO_ID,
      storeOf({ [worktreeId('/wt/gone')]: forkTarget() }),
      exec,
      []
    )
    expect(exec.mock.calls.length).toBeGreaterThan(0)
    for (const [args] of exec.mock.calls) {
      expect(() => validateGitExecArgs(args)).not.toThrow()
    }
  })
})

describe('reconcileOrphanedPrRemotes rate limiting', () => {
  it('exposes a test reset so repeated test runs are not affected by prior cooldowns', () => {
    expect(() => _resetPrRemoteReconciliationRateLimitForTests()).not.toThrow()
  })
})
