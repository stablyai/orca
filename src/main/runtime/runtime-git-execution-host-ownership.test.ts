import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as GitRemoteModule from '../git/remote'
import type * as GitStatusModule from '../git/status'
import type { ResolvedRuntimeGitWorktree } from './runtime-git-command-target'
import { RuntimeGitCommands } from './orca-runtime-git'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  gitFetch: vi.fn(),
  stageFile: vi.fn()
}))

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  getStatus: mocks.getStatus,
  stageFile: mocks.stageFile
}))

vi.mock('../git/remote', async () => ({
  ...(await vi.importActual<typeof GitRemoteModule>('../git/remote')),
  gitFetch: mocks.gitFetch
}))

function remoteCommands(): RuntimeGitCommands {
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/remote/repo',
    git: { path: '/remote/repo', branch: 'main', isBare: false, isMainWorktree: false }
  } as unknown as ResolvedRuntimeGitWorktree
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({ worktree, executionHostId: 'ssh:ssh-1' }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

describe('runtime Git execution-host ownership', () => {
  beforeEach(() => {
    mocks.getStatus.mockReset()
    mocks.gitFetch.mockReset()
    mocks.stageFile.mockReset()
  })

  it('never substitutes local reads, sync, or mutations for an SSH host', async () => {
    const commands = remoteCommands()

    await expect(commands.getRuntimeGitStatus('id:wt-1')).rejects.toThrow(
      SSH_HOST_NOT_SERVED_MESSAGE
    )
    await expect(commands.fetchRuntimeGit('id:wt-1')).rejects.toThrow(SSH_HOST_NOT_SERVED_MESSAGE)
    await expect(commands.stageRuntimeGitPath('id:wt-1', 'src/a.ts')).rejects.toThrow(
      SSH_HOST_NOT_SERVED_MESSAGE
    )
    expect(mocks.getStatus).not.toHaveBeenCalled()
    expect(mocks.gitFetch).not.toHaveBeenCalled()
    expect(mocks.stageFile).not.toHaveBeenCalled()
  })
})
