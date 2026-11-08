import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

// Keep asserted config bytes independent of platform socket-path limits.
vi.mock(
  '../codex/configuration/shared-server/codex-daemon-socket-path-guard',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    applyCodexDaemonSocketGuard: (config: string) => config
  })
)

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('preserves WSL account-home project trust while refreshing canonical settings', async () => {
    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslCanonicalHomePath = join(testState.userDataDir, 'wsl-home', '.codex')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    const wslLinuxCanonicalHomePath = '/home/alice/.codex'
    mkdirSync(wslManagedHomePath, { recursive: true })
    mkdirSync(wslCanonicalHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(wslManagedHomePath, 'config.toml'),
      'approval_policy = "untrusted"\n[projects."/workspace"]\ntrust_level = "trusted"\n',
      'utf-8'
    )
    writeFileSync(
      join(wslCanonicalHomePath, 'config.toml'),
      'sandbox_mode = "danger-full-access"\n',
      'utf-8'
    )

    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) => {
        if (path === wslManagedHomePath) {
          return { distro: 'Ubuntu', linuxPath: wslLinuxHomePath }
        }
        if (path === wslCanonicalHomePath) {
          return { distro: 'Ubuntu', linuxPath: wslLinuxCanonicalHomePath }
        }
        return null
      },
      toWindowsWslPath: (linuxPath: string) =>
        linuxPath === wslLinuxCanonicalHomePath ||
        linuxPath === `${wslLinuxCanonicalHomePath}/config.toml`
          ? linuxPath.endsWith('/config.toml')
            ? join(wslCanonicalHomePath, 'config.toml')
            : wslCanonicalHomePath
          : wslManagedHomePath
    }))
    // The distro runs: the config mirror may read its home.
    vi.doMock('../wsl/discovery/wsl-background-distro-gate', () => ({
      wasWslDistroLastSeenRunningSettled: () => true
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })

    const { CodexAccountService } = await import('./service')
    new CodexAccountService(
      createStore(settings) as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    expect(readFileSync(join(wslManagedHomePath, 'config.toml'), 'utf-8')).toBe(
      'sandbox_mode = "danger-full-access"\n\n' +
        '[projects."/workspace"]\ntrust_level = "trusted"\n'
    )
  })
})
