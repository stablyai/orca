import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { WorktreePushTargetStore } from './worktree-push-target-cleanup'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { ipcGitWorktreeTarget, materializeWorktreePushTargetRemote } from './worktree-remote'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'

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
    // Existing-remote reuse still needs per-branch refspec and upstream restoration.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get-all') {
        throw new Error('no such section')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/contributor/fix\n', stderr: '' }
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
    expect(calls).toContainEqual(['symbolic-ref', '--quiet', 'HEAD'])
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
        return { stdout: 'refs/heads/contributor/fix\n', stderr: '' }
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
      ['symbolic-ref', '--quiet', 'HEAD'],
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
        return { stdout: 'refs/heads/contributor/fix\n', stderr: '' }
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
    // Config widening imports no refs; a new sibling branch needs fetch before --set-upstream-to can succeed.
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
        return { stdout: 'refs/heads/contributor/fix\n', stderr: '' }
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
        return { stdout: 'refs/heads/contributor/fix\n', stderr: '' }
      }
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
    // Remote minting coalesces, but each joiner needs its own branch's refspec, fetch and upstream.
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
        return { stdout: 'refs/heads/joiner/branch\n', stderr: '' }
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

    expect(joined.branchName).toBe('joiner/branch')
    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual([
      'branch',
      '--set-upstream-to',
      `${FORK_REMOTE}/joiner/branch`,
      'joiner/branch'
    ])
    expect(calls.filter((call) => call[0] === 'remote' && call[1] === 'add')).toHaveLength(1)
  })

  it('propagates a failed mint instead of adopting a remote the rollback removed', async () => {
    // Failed mint removes the remote; adopting afterward would create a URL-less config ghost.
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
    expect(
      calls.filter((call) => call[0] === 'config' && String(call[2] ?? '').includes(FORK_REMOTE))
    ).toHaveLength(0)
  })

  it('persists remoteCreated to the store when a worktreeId is provided and the mint succeeds', async () => {
    // Deferred materialization must persist ownership so orphan reconciliation can reclaim its remote.
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
      getRepos: () => [
        { id: 'worktree-1', path: REPO_PATH, displayName: 'r', badgeColor: '#000', addedAt: 1 }
      ],
      setWorktreeMeta
    }

    const result = await materializeWorktreePushTargetRemote(
      REPO_PATH,
      target,
      store,
      undefined,
      {},
      ipcGitWorktreeTarget({ worktreeId: 'worktree-1' })
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    expect(setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'worktree-1', hostId: 'local' }),
      {
        pushTarget: { ...target, remoteCreated: true }
      }
    )
  })

  it('records the mint on the copy whose git ran, even when the repo has a twin on another host', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()
    const setWorktreeMeta = vi.fn()
    const repo = {
      id: 'worktree-1',
      path: REPO_PATH,
      displayName: 'r',
      badgeColor: '#000',
      addedAt: 1
    }
    const store: WorktreePushTargetStore = {
      getAllWorktreeMeta: () => ({}),
      getRepos: () => [
        { ...repo, executionHostId: 'local' },
        { ...repo, connectionId: 'box', executionHostId: 'ssh:box' }
      ],
      setWorktreeMeta
    }

    await materializeWorktreePushTargetRemote(
      REPO_PATH,
      target,
      store,
      undefined,
      {},
      ipcGitWorktreeTarget({ worktreeId: 'worktree-1' })
    )

    expect(setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'worktree-1', hostId: 'local' }),
      { pushTarget: { ...target, remoteCreated: true } }
    )
  })

  it("never adopts a remote as Orca's because a twin on another host created one", async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/contributor/fix\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()
    const setWorktreeMeta = vi.fn()
    const repo = { id: 'repo', path: REPO_PATH, displayName: 'r', badgeColor: '#000', addedAt: 1 }
    const store: WorktreePushTargetStore = {
      // The SSH twin's Orca-created remote shares this remote's name and URL.
      getAllWorktreeMeta: () => ({
        'repo::/ssh-wt': mergeWorktreeMetaForWrite(undefined, {
          hostId: 'ssh:box',
          pushTarget: { ...target, remoteCreated: true }
        })
      }),
      getRepos: () => [repo, { ...repo, connectionId: 'box', executionHostId: 'ssh:box' }],
      setWorktreeMeta
    }

    const result = await materializeWorktreePushTargetRemote(
      REPO_PATH,
      target,
      store,
      'repo',
      {},
      ipcGitWorktreeTarget({ worktreeId: 'repo::/local-wt' })
    )

    expect(result.remoteCreated).not.toBe(true)
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it("never reuses a remote as Orca's because a twin on another host minted it", async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return { stdout: `fork-x\t${FORK_URL} (fetch)\nfork-x\t${FORK_URL} (push)`, stderr: '' }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'fork-x', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const target = forkTarget()
    const setWorktreeMeta = vi.fn()
    const repo = { id: 'repo', path: REPO_PATH, displayName: 'r', badgeColor: '#000', addedAt: 1 }
    const store: WorktreePushTargetStore = {
      getAllWorktreeMeta: () => ({
        'repo::/ssh-wt': mergeWorktreeMetaForWrite(undefined, {
          hostId: 'ssh:box',
          pushTarget: { ...target, remoteName: 'fork-x', remoteCreated: true }
        })
      }),
      getRepos: () => [repo, { ...repo, connectionId: 'box', executionHostId: 'ssh:box' }],
      setWorktreeMeta
    }

    const result = await materializeWorktreePushTargetRemote(
      REPO_PATH,
      target,
      store,
      'repo',
      {},
      ipcGitWorktreeTarget({ worktreeId: 'repo::/local-wt' })
    )

    expect(result.remoteName).toBe('fork-x')
    expect(result.remoteCreated).not.toBe(true)
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
