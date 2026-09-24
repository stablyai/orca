import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createClaudeCredentialsWithoutEmail,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  readManagedCredentialsForTest,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

describe('Claude runtime config path', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    cleanupRuntimeAuthTestState()
  })

  it.each([false, true])(
    'updates and restores only the config used by the CLI (explicit directory: %s)',
    async (explicitDirectory) => {
      const configDir = join(testState.fakeHomeDir, '.claude')
      const homeConfigPath = join(testState.fakeHomeDir, '.claude.json')
      const nestedConfigPath = join(configDir, '.claude.json')
      const homeConfig = {
        oauthAccount: { accountUuid: 'home-account', emailAddress: 'home@example.com' },
        hasCompletedOnboarding: true
      }
      const nestedConfig = {
        oauthAccount: { accountUuid: 'nested-account', emailAddress: 'nested@example.com' },
        hasCompletedOnboarding: false
      }
      writeFileSync(homeConfigPath, JSON.stringify(homeConfig))
      writeFileSync(nestedConfigPath, JSON.stringify(nestedConfig))
      if (explicitDirectory) {
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
      }

      const configPath = explicitDirectory ? nestedConfigPath : homeConfigPath
      const untouchedPath = explicitDirectory ? homeConfigPath : nestedConfigPath
      const originalConfig = explicitDirectory ? nestedConfig : homeConfig
      const untouchedContents = readFileSync(untouchedPath, 'utf-8')
      const managedOauthAccount = { accountUuid: 'account-1', emailAddress: 'user@example.com' }
      const managedAuthPath = createManagedClaudeAuth(
        testState.userDataDir,
        'account-1',
        createClaudeCredentialsJson('user@example.com', 'managed'),
        JSON.stringify(managedOauthAccount)
      )
      const settings = createSettings({
        claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
      })
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      const service = new ClaudeRuntimeAuthService(createStore(settings) as never)
      await service.syncForCurrentSelection()
      settings.activeClaudeManagedAccountId = 'account-1'

      const preparation = await service.prepareForClaudeLaunch()

      expect(preparation.envPatch).toEqual(
        explicitDirectory ? { CLAUDE_CONFIG_DIR: configDir } : {}
      )
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
        ...originalConfig,
        oauthAccount: managedOauthAccount
      })
      expect(readFileSync(untouchedPath, 'utf-8')).toBe(untouchedContents)

      const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed', null, {
        expiresAt: Date.now() + 120_000
      })
      writeFileSync(join(configDir, '.credentials.json'), refreshedCredentials)
      await service.prepareForRateLimitFetch()

      expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
      expect(readFileSync(untouchedPath, 'utf-8')).toBe(untouchedContents)

      settings.activeClaudeManagedAccountId = null
      await service.syncForCurrentSelection()

      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(originalConfig)
      expect(readFileSync(untouchedPath, 'utf-8')).toBe(untouchedContents)
    }
  )
})
