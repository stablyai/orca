import { describe, expect, it, vi } from 'vitest'
import {
  provisionWorktreeTerminals,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'

type HostSettings = ReturnType<WorktreeTerminalProvisioningHost['getSettings']>

function createHost(overrides: Partial<HostSettings>): WorktreeTerminalProvisioningHost {
  const settings: HostSettings = {
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    ...overrides
  }
  return {
    canSpawn: () => true,
    createTerminal: vi.fn(async () => ({ handle: 'term-1' })),
    splitTerminal: vi.fn(async () => ({ handle: 'term-2' })),
    setTabColor: vi.fn(async () => {}),
    getSettings: () => settings,
    getPtyId: () => undefined,
    recordSetupCompletionToken: vi.fn()
  }
}

const args = {
  worktreeSelector: 'id:wt-1',
  worktreeId: 'wt-1',
  worktreePath: '/repo/wt-1',
  setup: { runnerScriptPath: '/repo/.git/orca/setup-runner.sh', envVars: {} },
  hasStartupTerminal: true,
  setupCommandPlatform: 'posix' as const
}

describe('provisionWorktreeTerminals', () => {
  it('makes host-created setup terminals exit their shell on success only when enabled', async () => {
    const off = createHost({})
    await provisionWorktreeTerminals(off, args)
    expect(off.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'bash /repo/.git/orca/setup-runner.sh' })
    )

    const on = createHost({ closeSetupTabOnSuccess: true })
    await provisionWorktreeTerminals(on, args)
    expect(on.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'bash /repo/.git/orca/setup-runner.sh && exit' })
    )
  })
})
