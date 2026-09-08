import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
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

describe('resolveSkillDiscoverySshTarget', () => {
  function sshHost(overrides: Partial<RuntimeSkillCommandHost> = {}): RuntimeSkillCommandHost {
    return {
      getRuntimeId: () => 'runtime-1',
      getUserDataPath: () => '/tmp/orca-runtime-skill-test',
      isPackaged: () => true,
      getSettings: () => ({}),
      listRepos: () => [{ id: 'repo-1', path: '/remote/app', connectionId: 'ssh-1' }],
      listFolderWorkspaces: () => [],
      listResolvedWorktrees: async () => [
        { id: 'repo-1::/workspace/app', path: '/remote/app', hostId: toSshExecutionHostId('ssh-1') }
      ],
      showManagedWorktree: async () => {
        throw new Error('unused')
      },
      getSshProvider: () => ({ requestHostRpc: vi.fn() }) as never,
      skillTransactionRecovery: Promise.resolve(),
      ...overrides
    } as RuntimeSkillCommandHost
  }

  // STA-2961: returning null for an SSH-owned worktree is what makes
  // `skills.discover` fall through and scan the local machine for a remote pane.
  it('resolves an SSH-owned worktree to its connection and runtime-recorded path', async () => {
    const resolved = await new RuntimeSkillInstallQueries(sshHost()).resolveSkillDiscoverySshTarget(
      'repo-1::/workspace/app'
    )

    expect(resolved).not.toBeNull()
    expect(resolved?.connectionId).toBe('ssh-1')
    expect(resolved?.workspace).toEqual({
      kind: 'worktree',
      id: 'repo-1::/workspace/app',
      path: '/remote/app'
    })
    expect(typeof resolved?.provider).toBe('function')
  })

  // The folder branch goes through parseWorkspaceKey, which routes a folder key
  // to folderWorkspaceId instead of worktreeId. Getting that wrong resolves null
  // and silently scans this machine for a remote folder workspace.
  it('resolves an SSH-owned folder workspace through its folder key', async () => {
    const host = sshHost({
      listRepos: () => [],
      listFolderWorkspaces: () => [
        { id: 'folder-1', folderPath: '/remote/folder', connectionId: 'ssh-2' }
      ],
      listResolvedWorktrees: async () => []
    })

    const resolved = await new RuntimeSkillInstallQueries(host).resolveSkillDiscoverySshTarget(
      folderWorkspaceKey('folder-1')
    )

    expect(resolved?.connectionId).toBe('ssh-2')
    expect(resolved?.workspace).toEqual({
      kind: 'folder',
      id: 'folder-1',
      path: '/remote/folder'
    })
  })

  it('returns null for a locally owned worktree so the native path still runs', async () => {
    const host = sshHost({
      listRepos: () => [{ id: 'repo-1', path: '/local/app' }],
      listResolvedWorktrees: async () => [
        { id: 'repo-1::/workspace/app', path: '/local/app', hostId: 'local' }
      ]
    })

    await expect(
      new RuntimeSkillInstallQueries(host).resolveSkillDiscoverySshTarget('repo-1::/workspace/app')
    ).resolves.toBeNull()
  })

  it('returns null when no workspace identity is supplied', async () => {
    const queries = new RuntimeSkillInstallQueries(sshHost())
    await expect(queries.resolveSkillDiscoverySshTarget(undefined)).resolves.toBeNull()
    await expect(queries.resolveSkillDiscoverySshTarget('')).resolves.toBeNull()
  })
})
