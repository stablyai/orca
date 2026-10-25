import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type * as GitRemoteModule from '../git/remote'
import type * as GitStatusModule from '../git/status'
import type * as GitForkSyncModule from '../git/fork-sync'
import type { ResolvedRuntimeGitWorktree } from './runtime-git-command-target'
import { RuntimeGitSyncCommands } from './runtime-git-sync-commands'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const mocks = vi.hoisted(() => ({
  abortMerge: vi.fn(),
  abortRebase: vi.fn(),
  commitChanges: vi.fn(),
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

  it('refuses every runtime git action on an SSH host without running git here', async () => {
    const commands = new RuntimeGitSyncCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree,
        executionHostId: 'ssh:conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(commands.abortRuntimeGitMerge('id:wt-1')).rejects.toThrow(SshHostNotServedError)
    await expect(commands.fetchRuntimeGit('id:wt-1', pushTarget)).rejects.toThrow(
      SshHostNotServedError
    )
    await expect(commands.pullRuntimeGit('id:wt-1', pushTarget)).rejects.toThrow(
      SshHostNotServedError
    )
    await expect(commands.commitRuntimeGit('id:wt-1', 'feat: remote')).rejects.toThrow(
      SshHostNotServedError
    )
    expect(mocks.abortMerge).not.toHaveBeenCalled()
    expect(mocks.gitFetch).not.toHaveBeenCalled()
    expect(mocks.gitPull).not.toHaveBeenCalled()
    expect(mocks.commitChanges).not.toHaveBeenCalled()
  })
})
