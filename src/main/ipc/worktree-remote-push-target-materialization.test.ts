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

  it('short-circuits on a single named-remote probe when the remote already exists', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemote(REPO_PATH, target)

    expect(result).toBe(target)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', FORK_REMOTE], {
      cwd: REPO_PATH
    })
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
    expect(calls).toContainEqual(['remote', 'add', FORK_REMOTE, FORK_URL])
    expect(calls).toContainEqual(['config', `remote.${FORK_REMOTE}.orca-created`, 'true'])
    expect(calls).toContainEqual([
      'fetch',
      FORK_REMOTE,
      `+refs/heads/${target.branchName}:refs/remotes/${FORK_REMOTE}/${target.branchName}`
    ])
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

  it('short-circuits on a single named-remote probe when the remote already exists', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${FORK_URL}\n`, stderr: '' }
      }
      throw new Error(`unexpected exec ${args.join(' ')}`)
    })
    const fetchRemoteTrackingRef = vi.fn()
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef } as unknown as SshGitProvider,
      REPO_PATH,
      target
    )

    expect(result).toBe(target)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(['remote', 'get-url', FORK_REMOTE], REPO_PATH)
    expect(fetchRemoteTrackingRef).not.toHaveBeenCalled()
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
