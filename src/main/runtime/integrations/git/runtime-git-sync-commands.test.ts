import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type * as GitRemoteModule from '../../../git/remote'

import type * as GitForkSyncModule from '../../../git/fork-sync'
import type { ResolvedRuntimeGitWorktree } from './runtime-git-command-target'
import { RuntimeGitSyncCommands } from './runtime-git-sync-commands'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'

const mocks = vi.hoisted(() => ({
  abortMerge: vi.fn(),
  abortRebase: vi.fn(),
  commitChanges: vi.fn(),
  gitSyncForkDefaultBranch: vi.fn(),
  gitFastForward: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn()
}))

vi.mock('../../../git/fork-sync', async () => ({
  ...(await vi.importActual<typeof GitForkSyncModule>('../../../git/fork-sync')),
  gitSyncForkDefaultBranch: mocks.gitSyncForkDefaultBranch
}))

vi.mock('../../../git/source-control/git-conflict-operation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  abortMerge: mocks.abortMerge,
  abortRebase: mocks.abortRebase
}))

vi.mock('../../../git/source-control/commit-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitChanges: mocks.commitChanges
}))

vi.mock('../../../git/remote', async () => ({
  ...(await vi.importActual<typeof GitRemoteModule>('../../../git/remote')),
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

describe('RuntimeGitSyncCommands admission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
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
