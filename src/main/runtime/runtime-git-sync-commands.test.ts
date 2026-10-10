import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type * as GitRemoteModule from '../git/remote'
import type * as GitStatusModule from '../git/status'
import type * as GitForkSyncModule from '../git/fork-sync'
import type { ResolvedRuntimeGitWorktree } from './runtime-git-command-target'
import { RuntimeGitSyncCommands } from './runtime-git-sync-commands'

const mocks = vi.hoisted(() => ({
  abortMerge: vi.fn(),
  abortRebase: vi.fn(),
  commitChanges: vi.fn(),
  getSshGitProvider: vi.fn(),
  gitSyncForkDefaultBranch: vi.fn(),
  gitFastForward: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn()
}))

vi.mock('../git/fork-sync', async () => ({
  ...(await vi.importActual<typeof GitForkSyncModule>('../git/fork-sync')),
  gitSyncForkDefaultBranch: mocks.gitSyncForkDefaultBranch
}))

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  abortMerge: mocks.abortMerge,
  abortRebase: mocks.abortRebase,
  commitChanges: mocks.commitChanges
}))

vi.mock('../git/remote', async () => ({
  ...(await vi.importActual<typeof GitRemoteModule>('../git/remote')),
  gitFastForward: mocks.gitFastForward,
  gitFetch: mocks.gitFetch,
  gitPull: mocks.gitPull
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
}))

const worktree = {
  id: 'wt-1',
  path: '/workspace/repo'
} as ResolvedRuntimeGitWorktree
const pushTarget = {
  remoteName: 'origin',
  branchName: 'main'
} satisfies GitPushTarget
const expectedUpstream = { owner: 'stablyai', repo: 'orca' }

describe('RuntimeGitSyncCommands admission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('prioritizes local runtime git actions and preserves host routing', async () => {
    const commands = new RuntimeGitSyncCommands({
      resolveRuntimeGitTarget: async () => ({
        executionHostId: 'local',
        worktree,
        localGitOptions: { wslDistro: 'Ubuntu' }
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })
    mocks.commitChanges.mockResolvedValue({ success: true })
    mocks.gitSyncForkDefaultBranch.mockResolvedValue({ status: 'up-to-date' })

    await commands.abortRuntimeGitMerge('id:wt-1')
    await commands.abortRuntimeGitRebase('id:wt-1')
    await commands.fetchRuntimeGit('id:wt-1', pushTarget)
    await commands.syncRuntimeGitForkDefaultBranch('id:wt-1', expectedUpstream)
    await commands.pullRuntimeGit('id:wt-1', pushTarget)
    await commands.fastForwardRuntimeGit('id:wt-1', pushTarget)
    await commands.commitRuntimeGit('id:wt-1', 'feat: prioritize user action')

    const options = { admissionTier: 'interactive', wslDistro: 'Ubuntu' }
    expect(mocks.abortMerge).toHaveBeenCalledWith(worktree.path, options)
    expect(mocks.abortRebase).toHaveBeenCalledWith(worktree.path, options)
    expect(mocks.gitFetch).toHaveBeenCalledWith(worktree.path, pushTarget, options)
    expect(mocks.gitSyncForkDefaultBranch).toHaveBeenCalledWith(
      worktree.path,
      expectedUpstream,
      options
    )
    expect(mocks.gitPull).toHaveBeenCalledWith(worktree.path, pushTarget, options)
    expect(mocks.gitFastForward).toHaveBeenCalledWith(worktree.path, pushTarget, options)
    expect(mocks.commitChanges).toHaveBeenCalledWith(
      worktree.path,
      'feat: prioritize user action',
      options
    )
  })

  it('keeps remote runtime git actions owned by the SSH provider', async () => {
    const provider = {
      abortMerge: vi.fn(),
      abortRebase: vi.fn(),
      commit: vi.fn().mockResolvedValue({ success: true }),
      fastForwardBranch: vi.fn(),
      fetchRemote: vi.fn(),
      syncForkDefaultBranch: vi.fn().mockResolvedValue({ status: 'up-to-date' }),
      pullBranch: vi.fn()
    }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitSyncCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree,
        executionHostId: 'ssh:conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await commands.abortRuntimeGitMerge('id:wt-1')
    await commands.abortRuntimeGitRebase('id:wt-1')
    await commands.fetchRuntimeGit('id:wt-1', pushTarget)
    await commands.syncRuntimeGitForkDefaultBranch('id:wt-1', expectedUpstream)
    await commands.pullRuntimeGit('id:wt-1', pushTarget)
    await commands.fastForwardRuntimeGit('id:wt-1', pushTarget)
    await commands.commitRuntimeGit('id:wt-1', 'feat: keep execution remote')

    expect(provider.abortMerge).toHaveBeenCalledWith(worktree.path)
    expect(provider.abortRebase).toHaveBeenCalledWith(worktree.path)
    expect(provider.fetchRemote).toHaveBeenCalledWith(worktree.path, pushTarget)
    expect(provider.syncForkDefaultBranch).toHaveBeenCalledWith(worktree.path, expectedUpstream)
    expect(provider.pullBranch).toHaveBeenCalledWith(worktree.path, pushTarget)
    expect(provider.fastForwardBranch).toHaveBeenCalledWith(worktree.path, pushTarget)
    expect(provider.commit).toHaveBeenCalledWith(worktree.path, 'feat: keep execution remote')
    expect(mocks.abortMerge).not.toHaveBeenCalled()
    expect(mocks.abortRebase).not.toHaveBeenCalled()
    expect(mocks.gitFetch).not.toHaveBeenCalled()
    expect(mocks.gitSyncForkDefaultBranch).not.toHaveBeenCalled()
    expect(mocks.gitPull).not.toHaveBeenCalled()
    expect(mocks.gitFastForward).not.toHaveBeenCalled()
    expect(mocks.commitChanges).not.toHaveBeenCalled()
  })
})
