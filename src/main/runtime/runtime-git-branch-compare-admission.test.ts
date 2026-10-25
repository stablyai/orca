import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeGitCommandHost, RuntimeGitTarget } from './runtime-git-command-target'

const mocks = vi.hoisted(() => ({
  getBranchCompare: vi.fn()
}))

vi.mock('../git/status', () => ({
  getBranchCompare: mocks.getBranchCompare,
  getBranchDiff: vi.fn(),
  getCommitCompare: vi.fn(),
  getCommitDiff: vi.fn(),
  getDiff: vi.fn()
}))
vi.mock('../git/repo', () => ({ getRemoteCommitUrl: vi.fn(), getRemoteFileUrl: vi.fn() }))
vi.mock('../git/runner', () => ({ awaitWindowsHostGitEnvironmentReady: vi.fn() }))

import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { RuntimeGitDiffCommands } from './runtime-git-diff-commands'

function makeCommands(overrides: Partial<RuntimeGitTarget> = {}): RuntimeGitDiffCommands {
  const target = {
    worktree: {
      id: 'wt-1',
      repoId: 'repo-1',
      path: 'C:\\repo',
      git: {
        path: 'C:\\repo',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false,
        head: 'a'.repeat(40)
      }
    },
    executionHostId: 'local',
    localGitOptions: { wslDistro: 'Ubuntu' },
    ...overrides
  } as RuntimeGitTarget
  const host = {
    resolveRuntimeGitTarget: async () => target,
    getRuntimeSettings: () => ({})
  } as unknown as RuntimeGitCommandHost
  return new RuntimeGitDiffCommands(host)
}

describe('RuntimeGitDiffCommands branch-compare admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBranchCompare.mockResolvedValue({ summary: {}, entries: [] })
  })

  it('preserves a background tier with WSL routing and defaults legacy callers to interactive', async () => {
    const commands = makeCommands()

    await commands.getRuntimeGitBranchCompare('id:wt-1', 'origin/main', 'background')
    await commands.getRuntimeGitBranchCompare('id:wt-1', 'origin/main')

    expect(mocks.getBranchCompare).toHaveBeenNthCalledWith(1, 'C:\\repo', 'origin/main', {
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })
    expect(mocks.getBranchCompare).toHaveBeenNthCalledWith(2, 'C:\\repo', 'origin/main', {
      wslDistro: 'Ubuntu',
      admissionTier: 'interactive'
    })
  })

  it('refuses an SSH execution host without running git here', async () => {
    const commands = makeCommands({ executionHostId: 'ssh:conn-1' })

    await expect(
      commands.getRuntimeGitBranchCompare('id:wt-1', 'origin/main', 'background')
    ).rejects.toThrow(SshHostNotServedError)
    expect(mocks.getBranchCompare).not.toHaveBeenCalled()
  })
})
