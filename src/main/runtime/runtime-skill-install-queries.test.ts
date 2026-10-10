import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type * as SkillSshRelayService from '../skills/skill-ssh-relay-service'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'

const mocks = vi.hoisted(() => ({ listSkillInstallsOnSshHost: vi.fn() }))

vi.mock('../skills/skill-ssh-relay-service', async (importOriginal) => ({
  ...(await importOriginal<typeof SkillSshRelayService>()),
  listSkillInstallsOnSshHost: mocks.listSkillInstallsOnSshHost
}))

import { RuntimeSkillInstallQueries } from './runtime-skill-install-queries'

describe('RuntimeSkillInstallQueries', () => {
  beforeEach(() => {
    mocks.listSkillInstallsOnSshHost.mockReset().mockResolvedValue([])
  })

  it('sends only worktrees owned by the requested SSH host to inventory', async () => {
    const worktreeId = 'repo-1::/workspace/app'
    const host: RuntimeSkillCommandHost = {
      getRuntimeId: () => 'runtime-1',
      getUserDataPath: () => '/tmp/orca-runtime-skill-test',
      isPackaged: () => true,
      getSettings: () => ({}),
      listRepos: () => [
        { id: 'repo-1', path: '/local/app' },
        { id: 'repo-1', path: '/remote/app', connectionId: 'ssh-1' }
      ],
      listFolderWorkspaces: () => [],
      listResolvedWorktrees: async () => [
        { id: worktreeId, path: '/local/app', hostId: 'local' },
        { id: worktreeId, path: '/remote/app', hostId: toSshExecutionHostId('ssh-1') }
      ],
      showManagedWorktree: async () => {
        throw new Error('unused')
      },
      getSshProvider: () => ({ requestHostRpc: vi.fn() }) as never,
      skillTransactionRecovery: Promise.resolve()
    }

    await new RuntimeSkillInstallQueries(host).listManagedSkillInstalls('ssh-1')

    expect(mocks.listSkillInstallsOnSshHost).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        workspaces: [{ kind: 'worktree', id: worktreeId, path: '/remote/app' }]
      })
    )
  })

  it('accepts a legacy worktree without hostId only when its repo has one host owner', async () => {
    const worktreeId = 'repo-1::/workspace/app'
    const host: RuntimeSkillCommandHost = {
      getRuntimeId: () => 'runtime-1',
      getUserDataPath: () => '/tmp/orca-runtime-skill-test',
      isPackaged: () => true,
      getSettings: () => ({}),
      listRepos: () => [{ id: 'repo-1', path: '/remote/app', connectionId: 'ssh-1' }],
      listFolderWorkspaces: () => [],
      listResolvedWorktrees: async () => [{ id: worktreeId, path: '/remote/app' }],
      showManagedWorktree: async () => {
        throw new Error('unused')
      },
      getSshProvider: () => ({ requestHostRpc: vi.fn() }) as never,
      skillTransactionRecovery: Promise.resolve()
    }

    await new RuntimeSkillInstallQueries(host).listManagedSkillInstalls('ssh-1')

    expect(mocks.listSkillInstallsOnSshHost).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaces: [{ kind: 'worktree', id: worktreeId, path: '/remote/app' }]
      })
    )
  })

  it('rejects legacy hostless inventory rows when the repo id spans hosts', async () => {
    const worktreeId = 'repo-1::/workspace/app'
    const host: RuntimeSkillCommandHost = {
      getRuntimeId: () => 'runtime-1',
      getUserDataPath: () => '/tmp/orca-runtime-skill-test',
      isPackaged: () => true,
      getSettings: () => ({}),
      listRepos: () => [
        { id: 'repo-1', path: '/local/app' },
        { id: 'repo-1', path: '/remote/app', connectionId: 'ssh-1' }
      ],
      listFolderWorkspaces: () => [],
      listResolvedWorktrees: async () => [{ id: worktreeId, path: '/unknown/app' }],
      showManagedWorktree: async () => {
        throw new Error('unused')
      },
      getSshProvider: () => ({ requestHostRpc: vi.fn() }) as never,
      skillTransactionRecovery: Promise.resolve()
    }

    await new RuntimeSkillInstallQueries(host).listManagedSkillInstalls('ssh-1')

    expect(mocks.listSkillInstallsOnSshHost).toHaveBeenCalledWith(
      expect.objectContaining({ workspaces: [] })
    )
  })

  it('uses the account-managed Claude config directory for global discovery', async () => {
    const host: RuntimeSkillCommandHost = {
      getRuntimeId: () => 'runtime-1',
      getUserDataPath: () => '/tmp/orca-runtime-skill-test',
      isPackaged: () => true,
      getSettings: () => ({}),
      listRepos: () => [],
      listFolderWorkspaces: () => [],
      listResolvedWorktrees: async () => [],
      showManagedWorktree: async () => {
        throw new Error('unused')
      },
      getSshProvider: () => undefined,
      getClaudeConfigDirectory: () => '/accounts/claude/managed',
      skillTransactionRecovery: Promise.resolve()
    }

    await expect(
      new RuntimeSkillInstallQueries(host).resolveSkillDiscoveryProviderRoots({
        kind: 'native-host'
      })
    ).resolves.toMatchObject({ claude: join('/accounts/claude/managed', 'skills') })
  })
})
