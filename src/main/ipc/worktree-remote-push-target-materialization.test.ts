import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { WorktreePushTargetStore } from './worktree-push-target-cleanup'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from './worktree-remote'

const REPO_PATH = '/repo-root'
const FORK_URL = 'git@github.com:contributor/orca.git'
const FORK_REMOTE = 'pr-contributor-orca'

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: FORK_URL,
    ...overrides
  }
}

describe('materializeWorktreePushTargetRemote', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('is a no-op when the target already reports remoteCreated', async () => {
    const target = forkTarget({ remoteCreated: true })

    const result = await materializeWorktreePushTargetRemote(REPO_PATH, target)

    expect(result).toBe(target)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('is a no-op for a same-repo target with no remoteUrl', async () => {
    const target = forkTarget({ remoteUrl: undefined })

    const result = await materializeWorktreePushTargetRemote(REPO_PATH, target)

    expect(result).toBe(target)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('short-circuits the remote probe but still restores upstream and widens the refspec', async () => {
    // Why (#17828 review follow-up): the short-circuit is the common case for every call
    // after the first, and for a sibling worktree reusing the same fork remote under a
    // different branch -- it must still restore the upstream link and widen the refspec.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get-all') {
        throw new Error('no such section')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'contributor/fix\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemote(REPO_PATH, target)

    expect(result).toBe(target)
    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual(['remote', 'get-url', FORK_REMOTE])
    expect(calls).toContainEqual([
      'config',
      '--add',
      `remote.${FORK_REMOTE}.fetch`,
      `+refs/heads/${target.branchName}*:refs/remotes/${FORK_REMOTE}/${target.branchName}*`
    ])
    expect(calls).toContainEqual(['config', `remote.${FORK_REMOTE}.tagOpt`, '--no-tags'])
    expect(calls).toContainEqual(['symbolic-ref', '--short', 'HEAD'])
    expect(calls).toContainEqual([
      'branch',
      '--set-upstream-to',
      `${FORK_REMOTE}/${target.branchName}`,
      'contributor/fix'
    ])
  })

  it('materializes the remote (add + provenance + fetch) when the probe misses', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemote(REPO_PATH, target)

    expect(result).toEqual({ ...target, remoteCreated: true })
    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    // Mint uses the narrow `-t <branch> --no-tags` add form (#17887), not a bare `remote add`.
    expect(calls).toContainEqual([
      'remote',
      'add',
      '-t',
      target.branchName,
      '--no-tags',
      FORK_REMOTE,
      FORK_URL
    ])
    expect(calls).toContainEqual(['config', `remote.${FORK_REMOTE}.orca-created`, 'true'])
    expect(calls).toContainEqual([
      'fetch',
      FORK_REMOTE,
      `+refs/heads/${target.branchName}*:refs/remotes/${FORK_REMOTE}/${target.branchName}*`
    ])
  })

  it('fetches the missing tracking ref before restoring upstream on the short-circuit path (#17828 sibling worktree)', async () => {
    // Why: a sibling worktree short-circuiting onto an already-existing remote under a
    // *new* branch has a widened refspec but no tracking ref yet -- against real git,
    // `branch --set-upstream-to` hard-fails with "the requested upstream branch does not
    // exist" unless something fetches that branch first. Verified against a real git
    // fixture, not just this mock (see PR discussion).
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get-all') {
        throw new Error('no such section')
      }
      if (args[0] === 'rev-parse') {
        throw new Error('unknown revision')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'contributor/fix\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemote(REPO_PATH, target)

    expect(result).toBe(target)
    const fetchCalls = gitExecFileAsyncMock.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'fetch'
    )
    expect(fetchCalls).toEqual([
      [
        [
          'fetch',
          FORK_REMOTE,
          `+refs/heads/${target.branchName}*:refs/remotes/${FORK_REMOTE}/${target.branchName}*`
        ],
        expect.objectContaining({ timeout: expect.any(Number) })
      ]
    ])
    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${FORK_REMOTE}/${target.branchName}`
    ])
    expect(calls).toContainEqual([
      'branch',
      '--set-upstream-to',
      `${FORK_REMOTE}/${target.branchName}`,
      'contributor/fix'
    ])
  })

  it('skips the fetch when the tracking ref already exists on the short-circuit path', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get-all') {
        throw new Error('no such section')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'contributor/fix\n', stderr: '' }
      }
      // rev-parse succeeds by default (ref already exists) -- no fetch should follow.
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()

    await materializeWorktreePushTargetRemote(REPO_PATH, target)

    const fetchCalls = gitExecFileAsyncMock.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'fetch'
    )
    expect(fetchCalls).toEqual([])
  })

  it("gives a joiner its own branch wiring instead of the minting sibling's target", async () => {
    // Why (#17828 review): the single flight is keyed on the remote, but the refspec widen,
    // tracking-ref fetch and upstream link are all per-branch. A sibling worktree joining an
    // in-flight mint for a *different* branch previously received the minter's target and
    // skipped all three, leaving its own branch with no upstream.
    let remoteExists = false
    let releaseAdd!: () => void
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (!remoteExists) {
          throw new Error('No such remote')
        }
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'add') {
        await addGate
        remoteExists = true
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get-all') {
        throw new Error('no such section')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'joiner/branch\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const minter = materializeWorktreePushTargetRemote(REPO_PATH, forkTarget())
    await Promise.resolve()
    const joiner = materializeWorktreePushTargetRemote(
      REPO_PATH,
      forkTarget({ branchName: 'joiner/branch' })
    )
    releaseAdd()
    const [, joined] = await Promise.all([minter, joiner])

    // The joiner keeps its own branch rather than inheriting the minter's.
    expect(joined.branchName).toBe('joiner/branch')
    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual([
      'branch',
      '--set-upstream-to',
      `${FORK_REMOTE}/joiner/branch`,
      'joiner/branch'
    ])
    // Exactly one mint: the joiner must not have raced a second `remote add`.
    expect(calls.filter((call) => call[0] === 'remote' && call[1] === 'add')).toHaveLength(1)
  })

  it('propagates a failed mint instead of adopting a remote the rollback removed', async () => {
    // Why (#17828 review): both mint rollbacks `remote remove`, so adopting after a failed mint
    // writes `remote.<name>.fetch` with no URL -- a config-only ghost that breaks
    // `git fetch --all`, forces later mints to a `-2` name, and survives `git remote remove`.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      if (args[0] === 'remote' && args[1] === 'add') {
        throw new Error('mint failed')
      }
      return { stdout: '', stderr: '' }
    })

    const minter = materializeWorktreePushTargetRemote(REPO_PATH, forkTarget())
    await Promise.resolve()
    const joiner = materializeWorktreePushTargetRemote(
      REPO_PATH,
      forkTarget({ branchName: 'joiner/branch' })
    )

    await expect(minter).rejects.toThrow()
    await expect(joiner).rejects.toThrow()
    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    // No ghost: nothing wrote refspec or tagOpt config for a remote that does not exist.
    expect(
      calls.filter((call) => call[0] === 'config' && String(call[2] ?? '').includes(FORK_REMOTE))
    ).toHaveLength(0)
  })

  it('persists remoteCreated to the store when a worktreeId is provided and the mint succeeds', async () => {
    // Why (#17828 review follow-up): on-demand materialization never went through the
    // create-time setWorktreeMeta write, so a lazily-minted remote stayed invisible to
    // #17842's orphan sweep (which gates solely on the stored remoteCreated flag).
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()
    const setWorktreeMeta = vi.fn()
    const store: WorktreePushTargetStore = {
      getAllWorktreeMeta: () => ({}),
      setWorktreeMeta
    } as unknown as WorktreePushTargetStore

    const result = await materializeWorktreePushTargetRemote(
      REPO_PATH,
      target,
      store,
      undefined,
      {},
      'worktree-1'
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    expect(setWorktreeMeta).toHaveBeenCalledWith('worktree-1', {
      pushTarget: { ...target, remoteCreated: true }
    })
  })

  it('does not touch the store when no worktreeId is provided', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()
    const setWorktreeMeta = vi.fn()
    const store: WorktreePushTargetStore = {
      getAllWorktreeMeta: () => ({}),
      setWorktreeMeta
    } as unknown as WorktreePushTargetStore

    await materializeWorktreePushTargetRemote(REPO_PATH, target, store)

    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })
})

describe('materializeWorktreePushTargetRemoteSsh', () => {
  it('is a no-op when the target already reports remoteCreated', async () => {
    const exec = vi.fn()
    const target = forkTarget({ remoteCreated: true })

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec } as unknown as SshGitProvider,
      REPO_PATH,
      target
    )

    expect(result).toBe(target)
    expect(exec).not.toHaveBeenCalled()
  })

  it('short-circuits the remote probe but still restores upstream (refspec widening is a local-only gap)', async () => {
    // Why: mirrors the local short-circuit's upstream restore. Refspec widening is
    // intentionally NOT mirrored here -- SSH's bare `remote add` is a pre-existing,
    // documented gap this fix does not touch.
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'contributor/fix\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn()
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef } as unknown as SshGitProvider,
      REPO_PATH,
      target
    )

    expect(result).toBe(target)
    const calls = exec.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual(['remote', 'get-url', FORK_REMOTE])
    expect(calls).toContainEqual(['symbolic-ref', '--short', 'HEAD'])
    expect(calls).toContainEqual([
      'branch',
      '--set-upstream-to',
      `${FORK_REMOTE}/${target.branchName}`,
      'contributor/fix'
    ])
    expect(calls.some((call) => call[0] === 'config' && String(call[2]).includes('.fetch'))).toBe(
      false
    )
    expect(fetchRemoteTrackingRef).not.toHaveBeenCalled()
  })

  it('fetches the missing tracking ref (one-off, no config write) before restoring upstream on the short-circuit path', async () => {
    // SSH mirror of the local sibling-worktree fix: refspec widening stays out of scope
    // here, but the branch must still be fetched once before `--set-upstream-to` can
    // succeed for a branch this remote has never pulled in.
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('unknown revision')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'contributor/fix\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef } as unknown as SshGitProvider,
      REPO_PATH,
      target
    )

    expect(result).toBe(target)
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith(
      REPO_PATH,
      FORK_REMOTE,
      target.branchName,
      `refs/remotes/${FORK_REMOTE}/${target.branchName}`
    )
    const calls = exec.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual([
      'branch',
      '--set-upstream-to',
      `${FORK_REMOTE}/${target.branchName}`,
      'contributor/fix'
    ])
    // Still no config write -- the fetch is a one-off refspec argument, not a widen.
    expect(calls.some((call) => call[0] === 'config' && String(call[2]).includes('.fetch'))).toBe(
      false
    )
  })

  it('materializes the remote (add + provenance + fetch) when the probe misses', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const markRemoteOrcaCreated = vi.fn(async () => {})
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef, markRemoteOrcaCreated } as unknown as SshGitProvider,
      REPO_PATH,
      target
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    const calls = exec.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual(['check-ref-format', '--branch', target.branchName])
    expect(calls).toContainEqual(['remote', 'add', FORK_REMOTE, FORK_URL])
    // Provenance is a narrow RPC, not exec: the relay's generic git.exec blocks config writes.
    expect(markRemoteOrcaCreated).toHaveBeenCalledWith(REPO_PATH, FORK_REMOTE)
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith(
      REPO_PATH,
      FORK_REMOTE,
      target.branchName,
      `refs/remotes/${FORK_REMOTE}/${target.branchName}`
    )
  })

  it('persists remoteCreated to the store when a worktreeId is provided and the mint succeeds', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const markRemoteOrcaCreated = vi.fn(async () => {})
    const target = forkTarget()
    const setWorktreeMeta = vi.fn()
    const store: WorktreePushTargetStore = {
      getAllWorktreeMeta: () => ({}),
      setWorktreeMeta
    } as unknown as WorktreePushTargetStore

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef, markRemoteOrcaCreated } as unknown as SshGitProvider,
      REPO_PATH,
      target,
      store,
      undefined,
      'worktree-1'
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    expect(setWorktreeMeta).toHaveBeenCalledWith('worktree-1', {
      pushTarget: { ...target, remoteCreated: true }
    })
  })

  // Moved from worktrees-ssh-fork-push-target-remote.test.ts: this behavior lives in
  // prepareWorktreePushTargetSsh (invoked here through the materialize wrapper, once
  // the fast probe misses) and is unchanged -- it just no longer runs at create time.
  it('names the relay upgrade when an older host still rejects the fork remote', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      if (args[0] === 'remote' && args[1] === 'add') {
        throw new Error('Destructive git remote operations are not allowed via exec')
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn()
    const target = forkTarget()

    await expect(
      materializeWorktreePushTargetRemoteSsh(
        { exec, fetchRemoteTrackingRef } as unknown as SshGitProvider,
        REPO_PATH,
        target
      )
    ).rejects.toThrow('Reconnect to deploy the latest relay')
    expect(fetchRemoteTrackingRef).not.toHaveBeenCalled()
  })

  it('drops the fork remote it just added when the SSH head fetch fails', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    const markRemoteOrcaCreated = vi.fn(async () => {})
    const target = forkTarget()

    await expect(
      materializeWorktreePushTargetRemoteSsh(
        { exec, fetchRemoteTrackingRef, markRemoteOrcaCreated } as unknown as SshGitProvider,
        REPO_PATH,
        target
      )
    ).rejects.toThrow('network unreachable')

    expect(exec).toHaveBeenCalledWith(['remote', 'remove', FORK_REMOTE], REPO_PATH)
  })

  // Regression: the rollback must not fire on ownership inherited from a sibling
  // worktree, deleting the remote that worktree is still pushing through. The probe
  // misses under the *requested* remote name so this reaches prepareWorktreePushTargetSsh's
  // own by-URL reuse scan, which finds the sibling's differently-named remote.
  it('keeps a reused fork remote a sibling worktree owns when the SSH head fetch fails', async () => {
    const SIBLING_REMOTE = 'pr-contributor-orca-existing'
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (args[2] === SIBLING_REMOTE) {
          return { stdout: `${FORK_URL}\n`, stderr: '' }
        }
        throw new Error('No such remote')
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return {
          stdout: [
            'origin\thttps://github.com/stablyai/orca.git (fetch)',
            'origin\thttps://github.com/stablyai/orca.git (push)',
            `${SIBLING_REMOTE}\t${FORK_URL} (fetch)`,
            `${SIBLING_REMOTE}\t${FORK_URL} (push)`
          ].join('\n'),
          stderr: ''
        }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: `origin\n${SIBLING_REMOTE}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    const target = forkTarget()
    const store: WorktreePushTargetStore = {
      getAllWorktreeMeta: () => ({
        'repo::/repo-root-sibling': {
          pushTarget: {
            remoteName: SIBLING_REMOTE,
            branchName: 'contributor/other',
            remoteUrl: FORK_URL,
            remoteCreated: true
          }
        }
      })
    } as unknown as WorktreePushTargetStore

    await expect(
      materializeWorktreePushTargetRemoteSsh(
        { exec, fetchRemoteTrackingRef } as unknown as SshGitProvider,
        REPO_PATH,
        target,
        store
      )
    ).rejects.toThrow('network unreachable')

    expect(exec).not.toHaveBeenCalledWith(['remote', 'remove', SIBLING_REMOTE], REPO_PATH)
    expect(exec).not.toHaveBeenCalledWith(
      ['remote', 'add', expect.anything(), expect.anything()],
      REPO_PATH
    )
  })
})
