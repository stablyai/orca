import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { GitPushTarget } from '../../shared/worktree/types'

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
    const target = forkTarget()

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef } as unknown as SshGitProvider,
      REPO_PATH,
      target
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    const calls = exec.mock.calls.map((call) => call[0] as string[])
    expect(calls).toContainEqual(['check-ref-format', '--branch', target.branchName])
    expect(calls).toContainEqual(['remote', 'add', FORK_REMOTE, FORK_URL])
    expect(calls).toContainEqual(['config', `remote.${FORK_REMOTE}.orca-created`, 'true'])
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith(
      REPO_PATH,
      FORK_REMOTE,
      target.branchName,
      `refs/remotes/${FORK_REMOTE}/${target.branchName}`
    )
  })
})
