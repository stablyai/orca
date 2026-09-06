import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'

const {
  materializeLocalMock,
  materializeSshMock,
  getSshGitProviderMock,
  getLocalProjectWorktreeGitOptionsMock
} = vi.hoisted(() => ({
  materializeLocalMock: vi.fn(),
  materializeSshMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn()
}))
vi.mock('../ipc/worktree-remote', () => ({
  materializeWorktreePushTargetRemote: materializeLocalMock,
  materializeWorktreePushTargetRemoteSsh: materializeSshMock
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

import { triggerTerminalSpawnPushTargetMaterialization } from './runtime-terminal-spawn-push-target-materialization'

const WORKTREE_PATH = '/repo/worktree'
const FORK_URL = 'git@github.com:contributor/orca.git'
const REPO_ID = 'repo-1'
const STORE = {} as Store
const LOCAL_REPO = { id: REPO_ID, path: '/repo', connectionId: null } as unknown as Repo
const SSH_REPO = { id: REPO_ID, path: '/repo', connectionId: 'conn-1' } as unknown as Repo

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: FORK_URL,
    ...overrides
  }
}

// Flush the fire-and-forget microtask queue so assertions see the dispatched call.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('triggerTerminalSpawnPushTargetMaterialization', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    materializeLocalMock.mockReset().mockResolvedValue(undefined)
    materializeSshMock.mockReset().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReset()
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('is a no-op when there is no push target', () => {
    triggerTerminalSpawnPushTargetMaterialization(WORKTREE_PATH, undefined, LOCAL_REPO, STORE)
    expect(materializeLocalMock).not.toHaveBeenCalled()
    expect(materializeSshMock).not.toHaveBeenCalled()
  })

  it('is a no-op for a same-repo push target with no remoteUrl', () => {
    triggerTerminalSpawnPushTargetMaterialization(
      WORKTREE_PATH,
      forkTarget({ remoteUrl: undefined }),
      LOCAL_REPO,
      STORE
    )
    expect(materializeLocalMock).not.toHaveBeenCalled()
  })

  it('is a no-op when the target already reports remoteCreated', () => {
    triggerTerminalSpawnPushTargetMaterialization(
      WORKTREE_PATH,
      forkTarget({ remoteCreated: true }),
      LOCAL_REPO,
      STORE
    )
    expect(materializeLocalMock).not.toHaveBeenCalled()
  })

  it('materializes over the local transport with resolved WSL git options, repoId and worktreeId, fire-and-forget', () => {
    getLocalProjectWorktreeGitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    const target = forkTarget()
    const result = triggerTerminalSpawnPushTargetMaterialization(
      WORKTREE_PATH,
      target,
      LOCAL_REPO,
      STORE,
      REPO_ID,
      'worktree-1'
    )
    expect(result).toBeUndefined()
    expect(getLocalProjectWorktreeGitOptionsMock).toHaveBeenCalledWith(STORE, LOCAL_REPO)
    expect(materializeLocalMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      target,
      STORE,
      REPO_ID,
      { wslDistro: 'Ubuntu' },
      'worktree-1'
    )
    expect(materializeSshMock).not.toHaveBeenCalled()
  })

  it('materializes over SSH when the repo has a connectionId and a provider is registered', () => {
    const provider = { exec: vi.fn() }
    getSshGitProviderMock.mockReturnValue(provider)
    const target = forkTarget()
    triggerTerminalSpawnPushTargetMaterialization(
      WORKTREE_PATH,
      target,
      SSH_REPO,
      STORE,
      REPO_ID,
      'worktree-1'
    )
    expect(getSshGitProviderMock).toHaveBeenCalledWith('conn-1')
    expect(materializeSshMock).toHaveBeenCalledWith(
      provider,
      WORKTREE_PATH,
      target,
      STORE,
      undefined,
      'worktree-1'
    )
    expect(materializeLocalMock).not.toHaveBeenCalled()
    expect(getLocalProjectWorktreeGitOptionsMock).not.toHaveBeenCalled()
  })

  it('is a no-op when the SSH connection has dropped (no registered provider)', () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    triggerTerminalSpawnPushTargetMaterialization(WORKTREE_PATH, forkTarget(), SSH_REPO, STORE)
    expect(materializeSshMock).not.toHaveBeenCalled()
    expect(materializeLocalMock).not.toHaveBeenCalled()
  })

  it('falls back to default git options when WSL project runtime resolution throws', () => {
    getLocalProjectWorktreeGitOptionsMock.mockImplementation(() => {
      throw new Error('repair-required')
    })
    triggerTerminalSpawnPushTargetMaterialization(WORKTREE_PATH, forkTarget(), LOCAL_REPO, STORE)
    expect(materializeLocalMock).toHaveBeenCalledWith(
      WORKTREE_PATH,
      forkTarget(),
      STORE,
      undefined,
      {},
      undefined
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to resolve local git options'),
      expect.any(Error)
    )
  })

  it('swallows a materialize rejection instead of crashing the caller', async () => {
    materializeLocalMock.mockRejectedValue(new Error('remote add failed'))
    expect(() =>
      triggerTerminalSpawnPushTargetMaterialization(WORKTREE_PATH, forkTarget(), LOCAL_REPO, STORE)
    ).not.toThrow()
    await flush()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to materialize push target remote'),
      expect.any(Error)
    )
  })
})
