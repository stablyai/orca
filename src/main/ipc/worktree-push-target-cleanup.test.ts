import { describe, expect, it, vi, type Mock } from 'vitest'
import { validateGitExecArgs } from '../../relay/git-exec-validator'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  findWorktreeMetaReferencingRemote,
  hasBranchConfigUsingRemote,
  sameGitHubRemoteUrl,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

type ExecMock = Mock<GitRemoteExec>

const REPO_PATH = '/repo-root'
const FORK_URL = 'git@github.com:contributor/orca.git'
const FORK_REMOTE = 'pr-contributor-orca'

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: FORK_URL,
    remoteCreated: true,
    ...overrides
  }
}

// Why: cleanup only reads meta.pushTarget, so the rest of WorktreeMeta is irrelevant.
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
  branchConfig?: string
  getUrl?: string
  getUrlThrows?: boolean
}

function makeExec(script: ExecScript = {}): ExecMock {
  const { branchConfig = '', getUrl = FORK_URL, getUrlThrows = false } = script
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'config') {
      return { stdout: branchConfig, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      if (getUrlThrows) {
        throw new Error('No such remote')
      }
      return { stdout: `${getUrl}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function removeCalls(exec: ExecMock): string[][] {
  return exec.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === 'remote' && args[1] === 'remove')
}

describe('cleanupUnusedWorktreePushTargetRemoteWithExec', () => {
  it('removes an Orca-created fork remote that nothing else uses', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('sends only argv the relay accepts, so SSH cleanup is not silently skipped', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    for (const [args] of exec.mock.calls) {
      expect(() => validateGitExecArgs(args)).not.toThrow()
    }
  })

  it('keeps a remote Orca did not create (remoteCreated falsy)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteCreated: false }),
      storeOf({ 'repo-1::/wt/a': forkTarget({ remoteCreated: false }) }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
    // Why: the store flag alone can't rule out ownership -- on-demand
    // materialization (#17828) never sets it, so cleanup also probes the
    // repo-local `orca-created` config provenance before bailing.
    expect(exec).toHaveBeenCalledWith(
      ['config', '--get', `remote.${FORK_REMOTE}.orca-created`],
      REPO_PATH
    )
  })

  it('never touches origin or upstream', async () => {
    for (const remoteName of ['origin', 'upstream']) {
      const exec = makeExec()
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        REPO_PATH,
        'repo-1::/wt/a',
        forkTarget({ remoteName }),
        storeOf({}),
        exec
      )
      expect(removeCalls(exec)).toEqual([])
    }
  })

  it('skips when the target has no remoteUrl', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteUrl: undefined }),
      storeOf({}),
      exec
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('keeps the remote when another worktree in the same repo uses the same remote name (multi-fork)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-1::/wt/b': forkTarget({ branchName: 'contributor/other' })
      }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('keeps the remote when another worktree points at the same fork via a differently-named remote', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        // Same fork URL (https form), different sanitized remote name.
        'repo-1::/wt/b': forkTarget({
          remoteName: 'fork-2',
          remoteUrl: 'https://github.com/contributor/orca.git'
        })
      }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('removes the remote even if a same-named remote exists in a DIFFERENT repo (remotes are repo-local)', async () => {
    const exec = makeExec()
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({
        'repo-1::/wt/a': forkTarget(),
        'repo-2::/wt/c': forkTarget()
      }),
      exec
    )
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('keeps the remote when a branch config still tracks it', async () => {
    const exec = makeExec({
      branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}`
    })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('checks branch config without line-array or whitespace-regex splitting', async () => {
    const exec = makeExec({
      branchConfig: [
        `branch.contributor/fix.pushRemote\tunused`,
        `  branch.contributor/fix.remote    ${FORK_REMOTE}  `
      ].join('\r\n')
    })
    const splitSpy = vi.spyOn(String.prototype, 'split')
    try {
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        REPO_PATH,
        'repo-1::/wt/a',
        forkTarget(),
        storeOf({ 'repo-1::/wt/a': forkTarget() }),
        exec
      )
      const usedUnboundedOutputSplit = splitSpy.mock.calls.some(([separator]) => {
        return (
          separator instanceof RegExp &&
          (separator.source === '\\r?\\n' || separator.source === '\\s+')
        )
      })
      expect(removeCalls(exec)).toEqual([])
      expect(usedUnboundedOutputSplit).toBe(false)
    } finally {
      splitSpy.mockRestore()
    }
  })

  it('keeps the remote when its URL no longer matches the fork (repurposed by the user)', async () => {
    const exec = makeExec({ getUrl: 'git@github.com:someone-else/orca.git' })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })

  it('removes a remote owned only via git-config provenance (lazily materialized, #17828)', async () => {
    // Why: on-demand materialization never sets the store's `remoteCreated`
    // flag, so ownership must also be provable from `remote.<name>.orca-created`.
    const exec = makeExec({ branchConfig: 'true' })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget({ remoteCreated: false }),
      storeOf({ 'repo-1::/wt/a': forkTarget({ remoteCreated: false }) }),
      exec
    )
    expect(removeCalls(exec)).toEqual([['remote', 'remove', FORK_REMOTE]])
  })

  it('does nothing when the remote is already gone (get-url throws)', async () => {
    const exec = makeExec({ getUrlThrows: true })
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      REPO_PATH,
      'repo-1::/wt/a',
      forkTarget(),
      storeOf({ 'repo-1::/wt/a': forkTarget() }),
      exec
    )
    expect(removeCalls(exec)).toEqual([])
  })
})

describe('hasBranchConfigUsingRemote', () => {
  it('requireExistingBranch: false (default) protects on config alone, even if the branch is gone', async () => {
    const exec = makeExec({ branchConfig: `branch.contributor/fix.remote ${FORK_REMOTE}` })
    await expect(hasBranchConfigUsingRemote(exec, REPO_PATH, forkTarget())).resolves.toBe(true)
  })

  it('requireExistingBranch: true only protects when the referencing branch still exists', async () => {
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'config') {
        return { stdout: `branch.contributor/fix.remote ${FORK_REMOTE}`, stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'main\ncontributor/fix\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    await expect(
      hasBranchConfigUsingRemote(exec, REPO_PATH, forkTarget(), { requireExistingBranch: true })
    ).resolves.toBe(true)
  })

  it('requireExistingBranch: true does not protect on a stale config entry from a deleted branch', async () => {
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'config') {
        return { stdout: `branch.contributor/fix.remote ${FORK_REMOTE}`, stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'main\n', stderr: '' } // contributor/fix no longer exists
      }
      return { stdout: '', stderr: '' }
    })
    await expect(
      hasBranchConfigUsingRemote(exec, REPO_PATH, forkTarget(), { requireExistingBranch: true })
    ).resolves.toBe(false)
  })

  it('extracts branch names containing dots correctly', async () => {
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'config') {
        return { stdout: `branch.release/1.2.3.remote ${FORK_REMOTE}`, stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'release/1.2.3\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    await expect(
      hasBranchConfigUsingRemote(exec, REPO_PATH, forkTarget(), { requireExistingBranch: true })
    ).resolves.toBe(true)
  })
})

describe('findWorktreeMetaReferencingRemote', () => {
  it('scopes matches to the given repo id and excludes worktrees without a pushTarget', () => {
    const store = storeOf({
      'repo-1::/wt/a': forkTarget(),
      'repo-1::/wt/b': undefined,
      'repo-2::/wt/c': forkTarget()
    })
    const matches = findWorktreeMetaReferencingRemote(store, 'repo-1', forkTarget())
    expect(matches.map((match) => match.worktreeId)).toEqual(['repo-1::/wt/a'])
  })
})

describe('sameGitHubRemoteUrl', () => {
  it('matches SSH and HTTPS forms of the same GitHub fork', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:contributor/orca.git',
        'https://github.com/contributor/orca.git'
      )
    ).toBe(true)
  })

  it('is case-insensitive on owner/repo', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:Contributor/Orca.git',
        'git@github.com:contributor/orca.git'
      )
    ).toBe(true)
  })

  it('does not match different forks', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@github.com:contributor/orca.git',
        'git@github.com:someone-else/orca.git'
      )
    ).toBe(false)
  })

  it('falls back to exact equality for non-GitHub hosts', () => {
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'git@gitlab.com:contributor/orca.git'
      )
    ).toBe(true)
    expect(
      sameGitHubRemoteUrl(
        'git@gitlab.com:contributor/orca.git',
        'https://gitlab.com/contributor/orca.git'
      )
    ).toBe(false)
  })
})
