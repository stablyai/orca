import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, store } from '../orca-runtime-test-fixtures.spec'

const LOOPBACK_HOOK_ENV = {
  ORCA_AGENT_HOOK_PORT: '54321',
  ORCA_AGENT_HOOK_TOKEN: 'loopback-secret-token',
  ORCA_AGENT_HOOK_ENV: 'production',
  ORCA_AGENT_HOOK_VERSION: '1',
  ORCA_AGENT_HOOK_ENDPOINT: '/Users/me/Library/Application Support/Orca/hook.env'
}

describe('OrcaRuntimeService SSH terminal agent-hook env', () => {
  it('does not send the local loopback hook receiver env to SSH terminals', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-hook-env'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    registerSshGitProvider('ssh-hook-env', {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      listWorktrees: vi
        .fn()
        .mockResolvedValue([
          { path: '/remote/repo', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
        ])
    } as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-hooks' })
    const runtime = new OrcaRuntimeService(remoteStore as never, undefined, {
      buildAgentHookPtyEnv: () => ({ ...LOOPBACK_HOOK_ENV })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      await runtime.createTerminal('path:/remote/repo', {
        command: 'claude',
        env: { ORCA_AGENT_HOOK_TOKEN: 'inherited-token' }
      })

      const spawnCall = spawn.mock.calls[0]?.[0] as
        | { connectionId?: string | null; env?: Record<string, string> }
        | undefined
      expect(spawnCall?.connectionId).toBe('ssh-hook-env')
      const env = spawnCall?.env ?? {}
      for (const key of Object.keys(LOOPBACK_HOOK_ENV)) {
        expect(env[key], key).toBeUndefined()
      }
      expect(env.ORCA_PANE_KEY).toEqual(expect.any(String))
      expect(env.ORCA_TAB_ID).toEqual(expect.any(String))
    } finally {
      unregisterSshGitProvider('ssh-hook-env')
    }
  })
})
