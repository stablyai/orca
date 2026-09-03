import { vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
export const hostPlatform = process.platform
export const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  activeKeychainCredentials: null as string | null,
  scopedKeychainCredentials: null as string | null,
  legacyKeychainCredentials: null as string | null,
  throwScopedKeychainRead: false,
  throwLegacyKeychainRead: false,
  throwRuntimeKeychainWrite: false,
  throwLegacyRuntimeKeychainWrite: false,
  throwScopedKeychainWrite: false,
  throwManagedKeychainRead: false,
  scopedKeychainWriteErrorMessage: 'scoped keychain write failed',
  runtimeWriteConfigDir: null as string | null,
  scopedKeychainCredentialsByConfigDir: new Map<string, string>(),
  managedKeychainCredentials: new Map<string, string>()
}

export function expectedRuntimeConfigDir(): string {
  return join(testState.fakeHomeDir, '.claude')
}

export function createElectronMock() {
  return {
    app: {
      getPath: () => testState.userDataDir
    }
  }
}

// Why: these tests exercise materialize/read-back/snapshot logic, not the
// network OAuth refresh (covered by oauth-refresh.test.ts). Default the token
// to "not expiring" so the proactive switch-in refresh never fires here and
// existing expectations hold; individual tests can override these mocks.
export function createOauthRefreshMock() {
  return {
    isOauthTokenExpiring: vi.fn(() => false),
    refreshClaudeOauthCredentials: vi.fn(async () => null)
  }
}

export function createKeychainMock() {
  return {
    readActiveClaudeKeychainCredentials: vi.fn(async (configDir?: string) => {
      if (configDir) {
        if (configDir !== expectedRuntimeConfigDir()) {
          return testState.legacyKeychainCredentials
        }
        return testState.scopedKeychainCredentials ?? testState.legacyKeychainCredentials
      }
      return testState.legacyKeychainCredentials
    }),
    writeActiveClaudeKeychainCredentials: vi.fn(async (contents: string, configDir?: string) => {
      if (configDir) {
        if (testState.throwScopedKeychainWrite) {
          throw new Error(testState.scopedKeychainWriteErrorMessage)
        }
        testState.scopedKeychainCredentials = contents
        testState.scopedKeychainCredentialsByConfigDir.set(configDir, contents)
      } else {
        testState.legacyKeychainCredentials = contents
      }
      testState.activeKeychainCredentials = contents
    }),
    deleteActiveClaudeKeychainCredentials: vi.fn(async () => {
      testState.scopedKeychainCredentials = null
      testState.scopedKeychainCredentialsByConfigDir.clear()
      testState.legacyKeychainCredentials = null
      testState.activeKeychainCredentials = null
    }),
    deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) => {
      if (configDir) {
        testState.scopedKeychainCredentials = null
        testState.scopedKeychainCredentialsByConfigDir.delete(configDir)
      } else {
        testState.legacyKeychainCredentials = null
      }
      testState.activeKeychainCredentials = null
    }),
    readActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) =>
      configDir
        ? (() => {
            if (testState.throwScopedKeychainRead) {
              throw new Error('scoped keychain read failed')
            }
            if (configDir !== expectedRuntimeConfigDir()) {
              return testState.scopedKeychainCredentialsByConfigDir.get(configDir) ?? null
            }
            return testState.scopedKeychainCredentials
          })()
        : (() => {
            if (testState.throwLegacyKeychainRead) {
              throw new Error('legacy keychain read failed')
            }
            return testState.legacyKeychainCredentials
          })()
    ),
    writeActiveClaudeKeychainCredentialsForRuntime: vi.fn(
      async (contents: string, configDir: string) => {
        if (testState.throwRuntimeKeychainWrite) {
          throw new Error('runtime keychain write failed')
        }
        testState.runtimeWriteConfigDir = configDir
        testState.scopedKeychainCredentials = contents
        testState.scopedKeychainCredentialsByConfigDir.set(configDir, contents)
        if (testState.throwLegacyRuntimeKeychainWrite) {
          console.warn(
            '[claude-runtime-auth] Failed to refresh legacy shared Keychain:',
            new Error('legacy runtime keychain write failed')
          )
          return
        }
        testState.legacyKeychainCredentials = contents
        testState.activeKeychainCredentials = contents
      }
    ),
    isTransientKeychainError: (error: unknown) => {
      const message = String((error as { message?: unknown })?.message ?? error).toLowerCase()
      return (
        message.includes('locked') ||
        message.includes('interaction is not allowed') ||
        message.includes('no user interaction') ||
        message.includes('user canceled') ||
        message.includes('user cancelled') ||
        message.includes('name or passphrase') ||
        message.includes('timed out')
      )
    },
    readManagedClaudeKeychainCredentials: vi.fn(async (accountId: string) => {
      if (testState.throwManagedKeychainRead) {
        throw new Error('managed keychain read failed')
      }
      return testState.managedKeychainCredentials.get(accountId) ?? null
    }),
    writeManagedClaudeKeychainCredentials: vi.fn(async (accountId: string, contents: string) => {
      testState.managedKeychainCredentials.set(accountId, contents)
    })
  }
}

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

/** Shared `beforeEach` body: fresh platform, module registry, and temp homes. */
export function resetRuntimeAuthTestState(): void {
  setPlatform('darwin')
  vi.resetModules()
  vi.clearAllMocks()
  testState.activeKeychainCredentials = null
  testState.scopedKeychainCredentials = null
  testState.legacyKeychainCredentials = null
  testState.throwScopedKeychainRead = false
  testState.throwLegacyKeychainRead = false
  testState.throwRuntimeKeychainWrite = false
  testState.throwLegacyRuntimeKeychainWrite = false
  testState.throwScopedKeychainWrite = false
  testState.runtimeWriteConfigDir = null
  testState.scopedKeychainCredentialsByConfigDir.clear()
  testState.managedKeychainCredentials.clear()
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-claude-runtime-'))
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-home-'))
  mkdirSync(join(testState.fakeHomeDir, '.claude'), { recursive: true })
}

/** Shared `afterEach` body. */
export function cleanupRuntimeAuthTestState(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  rmSync(testState.userDataDir, { recursive: true, force: true })
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
}

export function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings(testState.fakeHomeDir),
    ...overrides
  }
}

export function createStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = {
        ...settings,
        ...updates,
        notifications: {
          ...settings.notifications,
          ...updates.notifications
        }
      }
      return settings
    })
  }
}

export function createManagedClaudeAuth(
  rootDir: string,
  accountId: string,
  credentialsJson: string,
  oauthAccountJson = `{"accountUuid":"${accountId}"}\n`
): string {
  const managedAuthPath = join(rootDir, 'claude-accounts', accountId, 'auth')
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, 'utf-8')
  writeFileSync(join(managedAuthPath, '.credentials.json'), credentialsJson, 'utf-8')
  writeFileSync(join(managedAuthPath, 'oauth-account.json'), oauthAccountJson, 'utf-8')
  testState.managedKeychainCredentials.set(accountId, credentialsJson)
  // Production keeps ONE store per account on darwin: the Keychain item the CLI derives from the
  // account's own dir. Seed that too, or fixtures model a second copy that no longer exists.
  testState.scopedKeychainCredentialsByConfigDir.set(realpathSync(managedAuthPath), credentialsJson)
  return managedAuthPath
}

// Why: the scoped Keychain mock keys managed config dirs by path, so setting the shared field
// leaves the bridge reading whatever the previous launch wrote.
export function setScopedKeychainCredentialsForManagedPath(
  managedAuthPath: string,
  credentialsJson: string
): void {
  testState.scopedKeychainCredentialsByConfigDir.set(realpathSync(managedAuthPath), credentialsJson)
}

export function createClaudeAccount(
  id: string,
  managedAuthPath: string,
  overrides: Partial<ClaudeManagedAccount> = {}
): ClaudeManagedAccount {
  return {
    id,
    email: 'user@example.com',
    managedAuthPath,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

export function createClaudeCredentialsJson(
  email: string,
  accessToken: string,
  organizationUuid: string | null = null,
  expiresAt = Date.now() + 60_000
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      email,
      ...(organizationUuid ? { organizationUuid } : {}),
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt
    }
  })}\n`
}

export function createClaudeCredentialsWithoutEmail(
  accessToken: string,
  organizationUuid: string | null = null,
  options: { expiresAt?: number; refreshToken?: string } = {}
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      ...(organizationUuid ? { organizationUuid } : {}),
      accessToken,
      refreshToken: options.refreshToken ?? `${accessToken}-refresh`,
      expiresAt: options.expiresAt ?? Date.now() + 60_000
    }
  })}\n`
}

/**
 * Models the store the CLI owns, which is what production now reads and writes: the config-dir
 * scoped Keychain item with the same-home `.credentials.json` as its fallback. Reading the old
 * account-id-keyed service here would assert against a store nothing writes any more, and every
 * such test would pass while exercising nothing.
 */
export function readManagedCredentialsForTest(
  accountId: string,
  managedAuthPath: string
): string | null {
  if (process.platform === 'darwin') {
    // Fixtures seed both darwin stores, so order decides what this returns. Production writes
    // exactly one per account: the account-id-keyed service for a pre-isolation account, the
    // CLI-owned scoped item for an isolated one. This helper serves the legacy lane, so it reads
    // the id-keyed service first; isolated-lane tests assert against
    // `testState.scopedKeychainCredentialsByConfigDir` directly, which is the store that matters
    // there and reads far more clearly at the call site.
    const idKeyed = testState.managedKeychainCredentials.get(accountId)
    if (idKeyed !== undefined) {
      return idKeyed
    }
    const scoped =
      testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPath) ??
      testState.scopedKeychainCredentialsByConfigDir.get(realpathSync(managedAuthPath))
    if (scoped !== undefined) {
      return scoped
    }
  }
  const filePath = join(managedAuthPath, '.credentials.json')
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null
}

export function readRuntimeOauthAccountForTest(): unknown {
  const configPath = join(testState.fakeHomeDir, '.claude.json')
  if (!existsSync(configPath)) {
    return null
  }
  return (
    (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>).oauthAccount ?? null
  )
}
