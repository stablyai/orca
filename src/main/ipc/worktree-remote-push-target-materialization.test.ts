import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { WorktreePushTargetStore } from './worktree-push-target-cleanup'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { materializeWorktreePushTargetRemote } from './worktree-remote'

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

  it('preserves the legacy null-store failure after existing-remote adoption work', async () => {
    const commands: string[][] = []
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      commands.push(args)
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
    await expect(
      materializeWorktreePushTargetRemote(REPO_PATH, forkTarget(), null, 'repo-1')
    ).rejects.toBeInstanceOf(TypeError)
    expect(commands).toEqual([
      ['remote', 'get-url', FORK_REMOTE],
      ['config', '--get-all', `remote.${FORK_REMOTE}.fetch`],
      [
        'config',
        '--add',
        `remote.${FORK_REMOTE}.fetch`,
        `+refs/heads/contributor/fix*:refs/remotes/${FORK_REMOTE}/contributor/fix*`
      ],
      ['config', `remote.${FORK_REMOTE}.tagOpt`, '--no-tags'],
      ['rev-parse', '--verify', '--quiet', `refs/remotes/${FORK_REMOTE}/contributor/fix`],
      ['symbolic-ref', '--short', 'HEAD'],
      ['branch', '--set-upstream-to', `${FORK_REMOTE}/contributor/fix`, 'contributor/fix']
    ])
  })

  it('accepts a null store when both persistence identifiers are omitted', async () => {
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

    await expect(materializeWorktreePushTargetRemote(REPO_PATH, target, null)).resolves.toBe(target)
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['branch', '--set-upstream-to', `${FORK_REMOTE}/${target.branchName}`, 'contributor/fix'],
      { cwd: REPO_PATH }
    )
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
