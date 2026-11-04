import { describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import {
  withLaunchAccount,
  type LaunchAccountRouter,
  type LaunchTargetRuntime
} from './agent-launch-account'

const saved = (id: string): ClaudeManagedAccount => ({
  id,
  email: `${id}@example.test`,
  authMethod: 'subscription-oauth',
  managedAuthPath: `/profiles/${id}`,
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
})

function host(connectionId: string | null = null) {
  const runtime: LaunchTargetRuntime = {
    showTerminalWorkspaceLaunchScope: async () => ({ connectionId }),
    showRepo: async () => ({ connectionId })
  }
  const router = {
    savedAccount: (id: string) => (id === 'work' || id === 'signed-out' ? saved(id) : undefined),
    pinnedLaunchEnv: vi.fn(async (id: string | null) =>
      id === 'work' ? { CLAUDE_CONFIG_DIR: '/profiles/work' } : id === null ? {} : null
    )
  } satisfies LaunchAccountRouter
  return { runtime, router }
}

const launch = (overrides: Partial<AgentLaunchParams>): AgentLaunchParams => ({
  agent: 'claude',
  target: { kind: 'existing', worktree: 'id:repo::/w' },
  surface: 'terminal',
  ...overrides
})

describe('withLaunchAccount', () => {
  it("carries the account's env and marks the launch with its account", async () => {
    const { runtime, router } = host()
    await expect(withLaunchAccount(launch({ account: 'work' }), runtime, router)).resolves.toEqual(
      expect.objectContaining({
        accountEnv: { CLAUDE_CONFIG_DIR: '/profiles/work', ORCA_CLAUDE_ACCOUNT: 'work' }
      })
    )
    await withLaunchAccount(launch({ account: 'system' }), runtime, router)
    expect(router.pinnedLaunchEnv).toHaveBeenLastCalledWith(null)
  })

  it.each([
    [{ account: 'nobody' }, null, /No Claude account nobody/],
    [{ account: 'signed-out' }, null, /signed out/],
    [{ account: 'work', agent: 'codex' as const }, null, /Claude launches only/],
    [{ account: 'work', surface: 'chat' as const }, null, /--surface terminal/],
    [{ account: 'work' }, 'ssh-1', /not supported/]
  ])('refuses %o before preparing anything it cannot honor', async (overrides, ssh, message) => {
    const { runtime, router } = host(ssh)
    await expect(withLaunchAccount(launch(overrides), runtime, router)).rejects.toThrow(message)
    if (ssh) {
      expect(router.pinnedLaunchEnv).not.toHaveBeenCalled()
    }
  })
})
