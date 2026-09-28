import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
const execution = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
beforeEach(() => {
  resetRuntimeAuthTestState()
  setPlatform('win32')
})
afterEach(cleanupRuntimeAuthTestState)

describe('captured WSL Claude account preparation', () => {
  it.each([true, false])(
    'pins ownership reads and preserves selection when owned=%s',
    async (owned) => {
      const localPath = createManagedClaudeAuth(
        testState.userDataDir,
        'alice-account',
        createClaudeCredentialsJson('alice@example.test', 'token')
      )
      let defaultUser = 'alice'
      const runWslProcess = vi.fn(async (spec: { user?: string; script?: string }) => {
        await Promise.resolve()
        defaultUser = 'bob'
        expect(spec.user).toBe('alice')
        expect(spec.script).toContain('test "$(id -u)" = \'1000\'')
        expect(spec.script).toContain('test "$HOME" = \'/home/alice\'')
        return {
          code: owned ? 0 : 35,
          stdout: spec.script?.includes('exec cat')
            ? createClaudeCredentialsJson('alice@example.test', 'token')
            : '/home/alice/.local/share/orca/claude-accounts/alice-account/auth',
          stderr: '',
          timedOut: false
        }
      })
      vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess }))
      vi.doMock('../wsl', () => ({
        getDefaultWslDistro: () => 'Ubuntu',
        getWslHome: () => `\\\\wsl.localhost\\Ubuntu\\home\\${defaultUser}`,
        toWindowsWslPath: () => localPath
      }))
      const settings = createSettings({
        localAccountRuntime: 'host',
        claudeManagedAccounts: [
          createClaudeAccount(
            'alice-account',
            '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\claude-accounts\\alice-account\\auth',
            {
              managedAuthRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              wslLinuxAuthPath: '/home/alice/.local/share/orca/claude-accounts/alice-account/auth'
            }
          )
        ],
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'alice-account' } }
      })
      const store = createStore(settings)
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Auth preparation uses only the fixture getSettings/updateSettings methods.
      const service = new ClaudeRuntimeAuthService(store as never)
      if (owned) {
        expect(await service.prepareForClaudeLaunch(target, execution)).toMatchObject({
          wslExecution: execution,
          envPatch: {
            CLAUDE_CONFIG_DIR: '/home/alice/.local/share/orca/claude-accounts/alice-account/auth'
          }
        })
      } else {
        await expect(service.prepareForClaudeLaunch(target, execution)).rejects.toThrow(
          'captured execution owner'
        )
      }
      expect(runWslProcess).toHaveBeenCalledTimes(owned ? 2 : 1)
      expect(settings.activeClaudeManagedAccountIdsByRuntime?.wsl.Ubuntu).toBe('alice-account')
    }
  )
  it('uses the captured home for system auth after the distro default changes', async () => {
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\bob'
    }))
    const store = createStore(createSettings({ localAccountRuntime: 'host' }))
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Auth preparation uses only the fixture getSettings/updateSettings methods.
    const service = new ClaudeRuntimeAuthService(store as never)
    expect(await service.prepareForClaudeLaunch(target, execution)).toMatchObject({
      wslExecution: execution,
      wslLinuxConfigDir: '/home/alice/.claude'
    })
  })
})
