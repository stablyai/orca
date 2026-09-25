import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Store } from '../persistence'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import type { CodexResetCreditAttemptLedger } from '../../shared/codex-reset-credit-attempt-ledger'
import type { CodexRateLimitHomeResolution } from './runtime-home-service'

export const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  previousUserDataPath: undefined as string | undefined
}

/** Fresh managed-accounts + fake `~` per test; mirrors the original suite hooks. */
export function registerCodexAccountsTestHomes(): void {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-accounts-'))
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
    testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = testState.userDataDir
    mkdirSync(join(testState.fakeHomeDir, '.codex'), { recursive: true })
  })

  afterEach(() => {
    rmSync(testState.userDataDir, { recursive: true, force: true })
    rmSync(testState.fakeHomeDir, { recursive: true, force: true })
    if (testState.previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
    }
  })
}

export function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return createCodexAccountSettings(testState.fakeHomeDir, overrides)
}

export function createStore(settings: GlobalSettings) {
  let resetLedger: CodexResetCreditAttemptLedger = { version: 1, attempts: [] }
  let settingsPreviewActive = false
  const applySettings = (updates: Partial<GlobalSettings>) => {
    settings = {
      ...settings,
      ...updates,
      notifications: {
        ...settings.notifications,
        ...updates.notifications
      }
    }
    return settings
  }
  const updateSettings = (updates: Partial<GlobalSettings>) => {
    if (settingsPreviewActive) {
      throw new Error('Cannot update settings during a Codex account settings preview')
    }
    return applySettings(updates)
  }
  const withSettingsPreview: Store['withCodexAccountSettingsPreview'] = <T>(
    updates: Partial<GlobalSettings>,
    action: () => T
  ): T => {
    if (settingsPreviewActive) {
      throw new Error('Cannot nest Codex account settings previews')
    }
    const previousSettings = settings
    applySettings(updates)
    settingsPreviewActive = true
    try {
      const result = action()
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        void Promise.resolve(result).catch(() => {})
        throw new Error('Codex account settings preview callback must be synchronous')
      }
      return result
    } finally {
      settings = previousSettings
      settingsPreviewActive = false
    }
  }
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn(updateSettings),
    updateCodexAccountSettingsAndFlush: vi.fn(updateSettings),
    withCodexAccountSettingsPreview: withSettingsPreview,
    getCodexResetCreditAttemptLedger: vi.fn(() => structuredClone(resetLedger)),
    replaceCodexResetCreditAttemptLedgerAndFlush: vi.fn((next: CodexResetCreditAttemptLedger) => {
      resetLedger = structuredClone(next)
    }),
    updateCodexAccountSettingsAndResetLedgerAndFlush: vi.fn(
      (updates: Partial<GlobalSettings>, next: CodexResetCreditAttemptLedger) => {
        updateSettings(updates)
        resetLedger = structuredClone(next)
      }
    )
  } satisfies Partial<Store>
}

export function failNextAccountRemovalPersistence(store: ReturnType<typeof createStore>): void {
  store.updateCodexAccountSettingsAndResetLedgerAndFlush.mockImplementationOnce(() => {
    throw new Error('disk full')
  })
}

/** Rate-limit collaborator surface the accounts service calls into. */
export type RateLimitsStub = {
  refreshForCodexAccountChange: Mock<(...args: unknown[]) => Promise<void>>
  evictInactiveCodexCache: Mock<(...args: unknown[]) => void>
}

export function createRateLimits(): RateLimitsStub {
  return {
    refreshForCodexAccountChange: vi.fn().mockResolvedValue(undefined),
    evictInactiveCodexCache: vi.fn()
  }
}

/** Runtime-home collaborator surface the accounts service calls into. */
export type RuntimeHomeStub = {
  syncForCurrentSelection: Mock<(...args: unknown[]) => void>
  clearLastWrittenAuthJson: Mock<(...args: unknown[]) => void>
  prepareForRateLimitFetch: Mock<(...args: unknown[]) => CodexRateLimitHomeResolution>
}

export function createRuntimeHome(): RuntimeHomeStub {
  return {
    syncForCurrentSelection: vi.fn(),
    clearLastWrittenAuthJson: vi.fn(),
    prepareForRateLimitFetch: vi.fn((): CodexRateLimitHomeResolution => ({
      kind: 'ready',
      codexHomePath: null
    }))
  }
}

export function createManagedHome(
  rootDir: string,
  accountId: string,
  config = '',
  auth = ''
): string {
  const managedHomePath = join(rootDir, 'codex-accounts', accountId, 'home')
  mkdirSync(managedHomePath, { recursive: true })
  writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
  if (config) {
    writeFileSync(join(managedHomePath, 'config.toml'), config, 'utf-8')
  }
  if (auth) {
    writeFileSync(join(managedHomePath, 'auth.json'), auth, 'utf-8')
  }
  return managedHomePath
}

export function createCodexAuthJson(
  email: string,
  accountId: string,
  refreshToken: string
): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `${JSON.stringify(
    {
      tokens: {
        id_token: `header.${payload}.signature`,
        account_id: accountId,
        refresh_token: refreshToken
      }
    },
    null,
    2
  )}\n`
}
