import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import { RuntimeSkillInstallQueries } from './runtime-skill-install-queries'

describe('RuntimeSkillInstallQueries', () => {
  it('fails an SSH inventory without a host to read it from', async () => {
    const host: RuntimeSkillCommandHost = {
      getRuntimeId: () => 'runtime-1',
      getUserDataPath: () => '/tmp/orca-runtime-skill-test',
      isPackaged: () => true,
      getSettings: () => ({}),
      listRepos: () => [{ id: 'repo-1', path: '/remote/app', connectionId: 'ssh-1' }],
      listFolderWorkspaces: () => [],
      listResolvedWorktrees: async () => [],
      showManagedWorktree: async () => {
        throw new Error('unused')
      },
      skillTransactionRecovery: Promise.resolve()
    }

    await expect(
      new RuntimeSkillInstallQueries(host).listManagedSkillInstalls('ssh-1')
    ).rejects.toThrow('skill-install-ssh-relay-unavailable')
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
