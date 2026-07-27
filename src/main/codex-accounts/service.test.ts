/* eslint-disable max-lines -- test suite covers config sync, login seeding, and fallback scenarios */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { CodexRateLimitAccountsState, GlobalSettings } from '../../shared/types'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CodexResetCreditAttemptLedger } from '../../shared/codex-reset-credit-attempt-ledger'
import { buildWslCodexAvailabilityArgs, buildWslCodexLoginArgs } from './wsl-codex-command'
import type { readHookTrustEntries as ReadHookTrustEntries } from '../codex/config-toml-trust'

const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  previousUserDataPath: undefined as string | undefined
}

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

function decodeEncodedWslBashCommand(command: string): string {
  const encoded = command.match(/^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/)?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : command
}

// Why: the shipped code no longer reads a settings flag — the legacy mirror
// lane is reachable only through the test-rig env override. Route the old
// per-test override key to that env var so lane coverage keeps working.
type TestSettingsOverrides = Partial<GlobalSettings> & {
  codexSystemDefaultRealHomeEnabled?: boolean
}

function setRealHomeLaneForTest(enabled: boolean): void {
  process.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME = enabled ? '1' : '0'
}

const initialRealHomeLaneEnv = process.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME
afterEach(() => {
  if (initialRealHomeLaneEnv === undefined) {
    delete process.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME
  } else {
    process.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME = initialRealHomeLaneEnv
  }
})

function createSettings(overrides: TestSettingsOverrides = {}): GlobalSettings {
  const appFontFamily = overrides.appFontFamily ?? 'Geist'
  const agentStatusHooksEnabled = overrides.agentStatusHooksEnabled ?? true
  const tabAutoGenerateTitle = overrides.tabAutoGenerateTitle ?? false
  // Config-sync/hot-swap tests assert the shared-mirror path; production is
  // real-home always, so opt these managed cases out unless a test overrides it.
  setRealHomeLaneForTest(overrides.codexSystemDefaultRealHomeEnabled ?? false)
  return {
    workspaceDir: testState.fakeHomeDir,
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    localBaseRefSuggestionDismissed: false,
    autoRenameBranchFromWork: false,
    branchPrefix: 'git-username',
    branchPrefixCustom: '',
    theme: 'system',
    uiLanguage: 'system',
    appIcon: overrides.appIcon ?? 'classic',
    editorAutoSave: false,
    editorAutoSaveDelayMs: 1000,
    editorMinimapEnabled: false,
    markdownReviewToolsEnabled: true,
    terminalFontSize: 14,
    terminalFontFamily: 'JetBrains Mono',
    terminalFontWeight: 500,
    terminalLineHeight: 1,
    terminalScrollSensitivity: 1.15,
    terminalFastScrollSensitivity: 5,
    terminalTuiScrollSensitivity: 1,
    terminalGpuAcceleration: 'auto',
    terminalLigatures: 'auto',
    terminalCursorStyle: 'block',
    terminalCursorBlink: false,
    terminalThemeDark: 'orca-dark',
    terminalDividerColorDark: '#000000',
    terminalUseSeparateLightTheme: false,
    terminalThemeLight: 'orca-light',
    terminalDividerColorLight: '#ffffff',
    terminalInactivePaneOpacity: 0.5,
    terminalActivePaneOpacity: 1,
    terminalPaneOpacityTransitionMs: 150,
    terminalDividerThicknessPx: 1,
    terminalRightClickToPaste: false,
    terminalFocusFollowsMouse: false,
    terminalClipboardOnSelect: false,
    terminalAllowOsc52Clipboard: true,
    setupScriptLaunchMode: 'split-vertical',
    terminalScrollbackRows: 5_000,
    localAccountRuntime: 'host',
    localAccountWslDistro: null,
    openLinksInApp: false,
    openLinksInAppPreferencePrompted: false,
    rightSidebarOpenByDefault: true,
    sourceControlViewMode: 'list',
    sourceControlGroupOrder: 'changes-first',
    sourceControlCompareAgainstUpstream: false,
    showTitlebarAppName: true,
    showTasksButton: true,
    floatingTerminalEnabled: false,
    floatingTerminalCwd: '~',
    floatingTerminalTriggerLocation: 'floating-button',
    diffDefaultView: 'inline',
    combinedDiffFileTreeVisibleByDefault: false,
    prBotAuthorOverrides: [],
    notifications: {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      suppressWhenFocused: true,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 100
    },
    promptCacheTimerEnabled: false,
    promptCacheTtlMs: 300_000,
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    terminalScopeHistoryByWorktree: true,
    defaultTuiAgent: null,
    disabledTuiAgents: [],
    skipDeleteWorktreeConfirm: false,
    skipCloseTerminalWithRunningProcessConfirm: false,
    skipDeleteAutomationConfirm: false,
    skipCodexRateLimitResetConfirm: false,
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    visibleTaskProviders: ['github', 'gitlab', 'linear', 'jira'],
    visibleTaskProvidersDefaultedForJira: true,
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    minimaxGroupId: '',
    minimaxUsageModels: 'general',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    keepComputerAwakeWhileAgentsRun: false,
    confirmClosePinnedTab: true,
    terminalMacOptionAsAlt: 'false',
    terminalMacOptionAsAltMigrated: true,
    terminalJISYenToBackslash: false,
    experimentalMobile: false,
    mobileAutoRestoreFitMs: null,
    experimentalPet: false,
    experimentalActivity: true,
    experimentalTerminalAttention: false,
    compactWorktreeCards: false,
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'powershell.exe',
    enableGitHubAttribution: true,
    ...overrides,
    diffWordWrap: overrides.diffWordWrap ?? false,
    localWindowsRuntimeDefault: overrides.localWindowsRuntimeDefault ?? { kind: 'windows-host' },
    leftSidebarAppearanceMode: overrides.leftSidebarAppearanceMode ?? 'default',
    appFontFamily,
    agentStatusHooksEnabled,
    tabAutoGenerateTitle
  }
}

function createStore(settings: GlobalSettings) {
  let resetLedger: CodexResetCreditAttemptLedger = { version: 1, attempts: [] }
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
    }),
    getCodexResetCreditAttemptLedger: vi.fn(() => structuredClone(resetLedger)),
    replaceCodexResetCreditAttemptLedgerAndFlush: vi.fn((next: CodexResetCreditAttemptLedger) => {
      resetLedger = structuredClone(next)
    })
  }
}

function createRateLimits() {
  return {
    refreshForCodexAccountChange: vi.fn().mockResolvedValue(undefined),
    evictInactiveCodexCache: vi.fn()
  }
}

function createRuntimeHome() {
  return {
    syncForCurrentSelection: vi.fn(),
    clearLastWrittenAuthJson: vi.fn(),
    prepareForRateLimitFetch: vi.fn(() => null)
  }
}

function createResetCreditLimits(updatedAt = 30): ProviderRateLimits {
  return {
    provider: 'codex',
    session: {
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: 1_000,
      resetDescription: 'soon'
    },
    weekly: null,
    rateLimitResetCredits: {
      availableCount: 1,
      totalEarnedCount: 1,
      nextExpiresAt: 2_000,
      credits: [{ status: 'available', expiresAt: 2_000, grantedAt: 500 }]
    },
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function createResetRateLimitState(
  codex: ProviderRateLimits,
  target: RateLimitState['codexTarget'] = { runtime: 'host', wslDistro: null }
): RateLimitState {
  return {
    claude: null,
    codex,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: target,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function createManagedHome(rootDir: string, accountId: string, config = '', auth = ''): string {
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

function createCodexAuthJson(email: string, accountId: string, refreshToken: string): string {
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

async function createCanonicalHookTrustFixture(): Promise<{
  config: string
  orcaKeys: string[]
  userKey: string
}> {
  const { MANAGED_HOOK_TIMEOUT_SECONDS } = await import('../agent-hooks/installer-utils')
  const { getCodexManagedHookInstallMaterial } = await import('../codex/hook-service')
  const { computeTrustKey, computeTrustedHash, escapeTomlString, normalizeHookTrustKeyForLookup } =
    await import('../codex/config-toml-trust')
  const { getCodexHookTrustSignature } = await import('../codex/codex-hook-identity')
  const { writeCodexTrustGrantLedgerHome } = await import('../codex/codex-trust-grant-ledger')
  const sourceHomePath = join(testState.fakeHomeDir, '.codex')
  const sourcePath = join(sourceHomePath, 'hooks.json')
  const material = getCodexManagedHookInstallMaterial()
  const expectedHashEntry = {
    sourcePath,
    eventLabel: 'stop' as const,
    groupIndex: 0,
    handlerIndex: 0,
    command: material.command,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
  }
  const ledgerHashEntry = {
    ...expectedHashEntry,
    eventLabel: 'session_start' as const,
    groupIndex: 1
  }
  const userEntry = {
    ...expectedHashEntry,
    groupIndex: 2,
    command: 'user-authored-hook'
  }
  const expectedHashKey = computeTrustKey(expectedHashEntry)
  const ledgerHashKey = computeTrustKey(ledgerHashEntry)
  const userKey = computeTrustKey(userEntry)
  const ledgerTrustedHash = 'sha256:codex-granted-orca-hook'
  writeCodexTrustGrantLedgerHome(sourceHomePath, {
    binary: null,
    entries: {
      [normalizeHookTrustKeyForLookup(ledgerHashKey)]: {
        signature: getCodexHookTrustSignature(ledgerHashEntry),
        trustedHash: ledgerTrustedHash
      }
    }
  })
  const block = (key: string, trustedHash: string): string =>
    `[hooks.state."${escapeTomlString(key)}"]\ntrusted_hash = "${trustedHash}"\nenabled = true`
  return {
    config: [
      'approval_policy = "never"',
      block(expectedHashKey, computeTrustedHash(expectedHashEntry)),
      block(ledgerHashKey, ledgerTrustedHash),
      block(userKey, computeTrustedHash(userEntry))
    ].join('\n\n'),
    orcaKeys: [expectedHashKey, ledgerHashKey],
    userKey
  }
}

describe('CodexAccountService config sync', () => {
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

  it('syncs the canonical ~/.codex/config.toml into managed homes on startup', async () => {
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'approval_policy = "on-request"\n',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)

    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(canonicalConfig)
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"managed"}\n'
    )
  })

  it('does not seed source-home hook trust into a self-contained account home', async () => {
    const fixture = await createCanonicalHookTrustFixture()
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    writeFileSync(canonicalConfigPath, fixture.config, 'utf-8')
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'approval_policy = "on-request"\n'
    )
    const settings = createSettings({
      codexSystemDefaultRealHomeEnabled: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const { readHookTrustEntries } = await import('../codex/config-toml-trust')
    const { readCodexTrustGrantLedgerHome } = await import('../codex/codex-trust-grant-ledger')

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )
    const expectSanitizedManagedConfig = (): void => {
      const entries = readHookTrustEntries(join(managedHomePath, 'config.toml'))
      for (const key of fixture.orcaKeys) {
        expect(entries.has(key)).toBe(false)
      }
      // The launch-time hook mirror remaps user trust to this home's hooks.json.
      expect(entries.has(fixture.userKey)).toBe(false)
    }

    expectSanitizedManagedConfig()
    expect(readFileSync(canonicalConfigPath, 'utf-8')).toBe(fixture.config)
    expect(readCodexTrustGrantLedgerHome(join(testState.fakeHomeDir, '.codex'))).not.toBeNull()

    writeFileSync(join(managedHomePath, 'config.toml'), 'approval_policy = "untrusted"\n', 'utf-8')
    await service.selectAccount('account-1')

    expectSanitizedManagedConfig()
  })

  it('keeps flag-off config mirroring byte-identical', async () => {
    const fixture = await createCanonicalHookTrustFixture()
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    writeFileSync(canonicalConfigPath, fixture.config, 'utf-8')
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'approval_policy = "on-request"\n'
    )
    const settings = createSettings({
      codexSystemDefaultRealHomeEnabled: false,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
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

    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(fixture.config)
    expect(readFileSync(canonicalConfigPath, 'utf-8')).toBe(fixture.config)
  })

  it('rewrites relative path config values when syncing into managed homes', async () => {
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    writeFileSync(
      canonicalConfigPath,
      'model_instructions_file = "instructions.md"\nsandbox_mode = "danger-full-access"\n',
      'utf-8'
    )
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'approval_policy = "on-request"\n',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)

    const managedConfig = readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')
    expect(managedConfig).toContain(
      `model_instructions_file = '${join(testState.fakeHomeDir, '.codex', 'instructions.md')}'`
    )
    expect(managedConfig).toContain('sandbox_mode = "danger-full-access"')
  })

  it('does not rewrite managed configs that already match canonical config', async () => {
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const { escapeTomlString } = await import('../codex/config-toml-trust')
    const userHookKey = `${join(testState.fakeHomeDir, '.codex', 'user-hooks.json')}:stop:0:0`
    const canonicalConfig = [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      `[hooks.state."${escapeTomlString(userHookKey)}"]`,
      'trusted_hash = "sha256:user-owned"',
      ''
    ].join('\n')
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      canonicalConfig,
      '{"account":"managed"}\n'
    )
    const managedConfigPath = join(managedHomePath, 'config.toml')
    const oldDate = new Date('2024-01-01T00:00:00.000Z')
    utimesSync(managedConfigPath, oldDate, oldDate)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)

    expect(statSync(managedConfigPath).mtimeMs).toBeLessThan(Date.now() - 60_000)
  })

  it('does not sync configs when ~/.codex/config.toml is missing', async () => {
    const firstManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'sandbox_mode = "danger-full-access"\n',
      '{"account":"one"}\n'
    )
    const secondManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-2',
      'sandbox_mode = "workspace-write"\n',
      '{"account":"two"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: firstManagedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: secondManagedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ]
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)

    expect(readFileSync(join(firstManagedHomePath, 'config.toml'), 'utf-8')).toBe(
      'sandbox_mode = "danger-full-access"\n'
    )
    expect(readFileSync(join(secondManagedHomePath, 'config.toml'), 'utf-8')).toBe(
      'sandbox_mode = "workspace-write"\n'
    )
  })

  it('re-syncs config when selecting an account', async () => {
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'approval_policy = "on-request"\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    writeFileSync(join(managedHomePath, 'config.toml'), 'approval_policy = "untrusted"\n', 'utf-8')

    await service.selectAccount('account-1')

    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(canonicalConfig)
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(1)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(1)
  })

  it('does not throw on startup when the canonical config path is unreadable', async () => {
    mkdirSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), { recursive: true })
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      'approval_policy = "on-request"\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexAccountService } = await import('./service')

    expect(
      () => new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)
    ).not.toThrow()
    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(
      'approval_policy = "on-request"\n'
    )
    expect(warnSpy).toHaveBeenCalled()
  })

  it('seeds the managed home config before codex login runs', async () => {
    vi.resetModules()

    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig =
      'model_provider = "openai"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')

    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()

        const loginHome = options.env.CODEX_HOME
        expect(loginHome).toBeTruthy()
        expect(readFileSync(join(loginHome!, 'config.toml'), 'utf-8')).toBe(canonicalConfig)

        const payload = Buffer.from(JSON.stringify({ email: 'user@example.com' })).toString(
          'base64url'
        )
        writeFileSync(
          join(loginHome!, 'auth.json'),
          JSON.stringify({
            tokens: {
              id_token: `header.${payload}.signature`
            }
          }),
          'utf-8'
        )

        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await service.addAccount()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(1)
  })

  it('does not seed source-home hook trust when adding a self-contained account', async () => {
    vi.resetModules()
    let fixture: Awaited<ReturnType<typeof createCanonicalHookTrustFixture>>
    let readHookTrustEntries: typeof ReadHookTrustEntries
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()

        const loginHome = options.env.CODEX_HOME
        expect(loginHome).toBeTruthy()
        const entries = readHookTrustEntries(join(loginHome!, 'config.toml'))
        for (const key of fixture.orcaKeys) {
          expect(entries.has(key)).toBe(false)
        }
        expect(entries.has(fixture.userKey)).toBe(false)
        writeFileSync(
          join(loginHome!, 'auth.json'),
          createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
          'utf-8'
        )

        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))
    fixture = await createCanonicalHookTrustFixture()
    readHookTrustEntries = (await import('../codex/config-toml-trust')).readHookTrustEntries
    writeFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), fixture.config, 'utf-8')

    const store = createStore(createSettings({ codexSystemDefaultRealHomeEnabled: true }))
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await service.addAccount()

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('rejects OAuth account add when canonical config pins a custom provider', async () => {
    vi.resetModules()

    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = [
      'model_provider = "codex-lb"',
      'model = "gpt-5.2-codex"',
      '',
      '[model_providers.codex-lb]',
      'name = "Codex load balancer"',
      'base_url = "https://codex-lb.example.test/v1"',
      'env_key = "CODEX_LB_API_KEY"',
      ''
    ].join('\n')
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')

    const spawnMock = vi.fn()
    vi.doMock('node:crypto', () => ({ randomUUID: () => 'account-id-for-test' }))
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))

    try {
      const settings = createSettings()
      const store = createStore(settings)
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await expect(service.addAccount()).rejects.toThrow(
        'Orca cannot add a Codex OAuth account while ~/.codex/config.toml pins the custom provider "codex-lb". Keep using the system-default account for this provider, or remove model_provider (or set it to "openai") before adding an OAuth account. Orca left your config unchanged.'
      )

      expect(spawnMock).not.toHaveBeenCalled()
      expect(store.updateSettings).not.toHaveBeenCalled()
      expect(runtimeHome.syncForCurrentSelection).not.toHaveBeenCalled()
      expect(existsSync(join(testState.userDataDir, 'codex-accounts', 'account-id-for-test'))).toBe(
        false
      )
      expect(readFileSync(canonicalConfigPath, 'utf-8')).toBe(canonicalConfig)
    } finally {
      vi.doUnmock('node:crypto')
      vi.doUnmock('node:child_process')
    }
  })

  it('recreates the expected missing managed home before reauthenticating', async () => {
    vi.resetModules()

    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = 'sandbox_mode = "danger-full-access"\n'
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')

    const managedHomePath = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const loginHome = options.env.CODEX_HOME
        expect(loginHome).toBeTruthy()
        expect(readFileSync(join(loginHome!, '.orca-managed-home'), 'utf-8')).toBe('account-1\n')
        expect(readFileSync(join(loginHome!, 'config.toml'), 'utf-8')).toBe(canonicalConfig)

        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()
        writeFileSync(
          join(loginHome!, 'auth.json'),
          createCodexAuthJson('new@example.com', 'provider-account-1', 'refresh-token'),
          'utf-8'
        )
        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.reauthenticateAccount('account-1')

    expect(result.accounts[0]).toMatchObject({
      email: 'new@example.com',
      providerAccountId: 'provider-account-1'
    })
    expect(existsSync(managedHomePath)).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it.each([
    {
      label: 'the active account',
      accountId: 'account-1',
      outcome: 'success',
      expectedActiveAccountId: 'account-1',
      expectedUpdateCount: 2
    },
    {
      label: 'a different account',
      accountId: 'account-2',
      outcome: 'success',
      expectedActiveAccountId: 'account-1',
      expectedUpdateCount: 2
    },
    {
      label: 'a login that fails',
      accountId: 'account-1',
      outcome: 'login-failure',
      expectedActiveAccountId: null,
      expectedUpdateCount: 1
    },
    {
      label: 'credentials rejected by runtime validation',
      accountId: 'account-1',
      outcome: 'runtime-validation-failure',
      expectedActiveAccountId: null,
      expectedUpdateCount: 3
    }
  ])('keeps host selection semantics when reauthenticating $label', async (testCase) => {
    vi.resetModules()

    const hostAccounts = ['account-1', 'account-2'].map((id, index) => ({
      id,
      email: `${id}@example.com`,
      managedHomePath: createManagedHome(
        testState.userDataDir,
        id,
        '',
        createCodexAuthJson(`${id}@example.com`, `provider-${id}`, `refresh-${id}`)
      ),
      providerAccountId: `provider-${id}`,
      workspaceLabel: null,
      workspaceAccountId: `provider-${id}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      lastAuthenticatedAt: index + 1
    }))
    const wslAccount = {
      id: 'account-wsl',
      email: 'account-wsl@example.com',
      managedHomePath: createManagedHome(
        testState.userDataDir,
        'account-wsl',
        '',
        createCodexAuthJson('account-wsl@example.com', 'provider-wsl', 'refresh-wsl')
      ),
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      wslLinuxHomePath: '/home/test/.local/share/orca/codex-accounts/account-wsl/home',
      providerAccountId: 'provider-wsl',
      workspaceLabel: null,
      workspaceAccountId: 'provider-wsl',
      createdAt: 3,
      updatedAt: 3,
      lastAuthenticatedAt: 3
    }
    const settings = createSettings({
      codexManagedAccounts: [...hostAccounts, wslAccount],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'account-wsl' }
      }
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()
        const current = store.getSettings()
        store.updateSettings({
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: {
            ...current.activeCodexManagedAccountIdsByRuntime!,
            host: null,
            wsl: { Ubuntu: null }
          }
        })
        if (testCase.outcome === 'login-failure') {
          queueMicrotask(() => child.emit('close', 1))
          return child
        }
        writeFileSync(
          join(options.env.CODEX_HOME!, 'auth.json'),
          createCodexAuthJson('reauthenticated@example.com', 'provider-new', 'refresh-new'),
          'utf-8'
        )
        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    runtimeHome.syncForCurrentSelection.mockImplementation(() => {
      if (testCase.outcome !== 'runtime-validation-failure') {
        return
      }
      const current = store.getSettings()
      store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...current.activeCodexManagedAccountIdsByRuntime!,
          host: null
        }
      })
    })
    const rateLimits = createRateLimits()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    let result: CodexRateLimitAccountsState | null = null
    if (testCase.outcome === 'login-failure') {
      await expect(service.reauthenticateAccount(testCase.accountId)).rejects.toThrow(
        'Codex login exited with code 1.'
      )
    } else {
      result = await service.reauthenticateAccount(testCase.accountId)
    }

    expect(result?.activeAccountId ?? null).toBe(testCase.expectedActiveAccountId)
    if (result) {
      expect(result.activeAccountIdsByRuntime).toEqual({
        host: testCase.expectedActiveAccountId,
        wsl: { Ubuntu: null }
      })
    }
    expect(store.getSettings()).toMatchObject({
      activeCodexManagedAccountId: testCase.expectedActiveAccountId,
      activeCodexManagedAccountIdsByRuntime: {
        host: testCase.expectedActiveAccountId,
        wsl: { Ubuntu: null }
      }
    })
    const completedLogin = testCase.outcome !== 'login-failure'
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(completedLogin ? 1 : 0)
    if (completedLogin) {
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledWith(undefined, {
        runtime: 'host'
      })
    }
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(completedLogin ? 1 : 0)
    expect(store.updateSettings).toHaveBeenCalledTimes(testCase.expectedUpdateCount)
  })

  it('does not recreate a missing managed home at a different account path', async () => {
    vi.resetModules()
    const managedHomePath = join(testState.userDataDir, 'codex-accounts', 'other-account', 'home')
    const expectedManagedHomePath = join(
      testState.userDataDir,
      'codex-accounts',
      'account-1',
      'home'
    )
    const spawnMock = vi.fn()

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'Managed Codex home directory does not exist on disk.'
    )
    expect(existsSync(expectedManagedHomePath)).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not trust an existing managed home that is missing its ownership marker', async () => {
    vi.resetModules()
    const managedHomePath = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(managedHomePath, { recursive: true })
    const spawnMock = vi.fn()

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'Managed Codex home is missing Orca ownership marker.'
    )
    expect(spawnMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('adds a managed Codex account inside WSL when the account context is WSL', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-managed-home')
    const wslConfigPath = join(testState.userDataDir, 'wsl-config.toml')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-id-for-test/home'
    writeFileSync(
      wslConfigPath,
      'sandbox_mode = "danger-full-access"\nmodel_instructions_file = "instructions.md"\n',
      'utf-8'
    )

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      expect(args.slice(0, 2)).toEqual(['-d', 'Debian'])
      if (script.includes('WSL_DISTRO_NAME')) {
        return 'Debian\n/home/alice\n'
      }
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      if (script.includes('command -v codex')) {
        throw new Error('bash -ic does not inherit the distro login-shell PATH')
      }
      if (args.slice(2, 5).join(' ') === '-- sh -c') {
        expect(args).toEqual(buildWslCodexAvailabilityArgs('Debian'))
        return ''
      }
      mkdirSync(wslManagedHomePath, { recursive: true })
      writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-id-for-test\n')
      return ''
    })
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Debian', wslLinuxHomePath))
      // Why: codex login runs inside WSL, so the rewritten path must be the
      // Linux-side ~/.codex, not a Windows UNC path.
      expect(readFileSync(join(wslManagedHomePath, 'config.toml'), 'utf-8')).toBe(
        'sandbox_mode = "danger-full-access"\n' +
          "model_instructions_file = '/home/alice/.codex/instructions.md'\n"
      )
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()

      const payload = Buffer.from(JSON.stringify({ email: 'wsl@example.com' })).toString(
        'base64url'
      )
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } }),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:crypto', () => ({
      randomUUID: () => 'account-id-for-test'
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Debian', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: (linuxPath: string) =>
        linuxPath.endsWith('/.codex/config.toml') ? wslConfigPath : wslManagedHomePath
    }))

    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.addAccount({ runtime: 'wsl', wslDistro: 'Debian' })

      expect(result.accounts[0]).toMatchObject({
        email: 'wsl@example.com',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Debian'
      })
      expect(store.getSettings().codexManagedAccounts[0]).toMatchObject({
        managedHomePath: wslManagedHomePath,
        wslLinuxHomePath,
        managedHomeRuntime: 'wsl'
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('fails WSL Codex account add with an actionable message when codex is missing in the distro', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-managed-home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-id-for-test/home'

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      expect(args.slice(0, 2)).toEqual(['-d', 'Debian'])
      if (script.includes('WSL_DISTRO_NAME')) {
        return 'Debian\n/home/alice\n'
      }
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      if (args.slice(2, 5).join(' ') === '-- sh -c') {
        expect(args).toEqual(buildWslCodexAvailabilityArgs('Debian'))
        throw new Error('codex missing')
      }
      mkdirSync(wslManagedHomePath, { recursive: true })
      writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-id-for-test\n')
      return ''
    })
    const spawnMock = vi.fn()

    vi.doMock('node:crypto', () => ({
      randomUUID: () => 'account-id-for-test'
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Debian', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await expect(service.addAccount({ runtime: 'wsl', wslDistro: 'Debian' })).rejects.toThrow(
        'Codex CLI is not available in WSL Debian'
      )
      expect(spawnMock).not.toHaveBeenCalled()
      expect(existsSync(wslManagedHomePath)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('reauthenticates a WSL managed Codex account inside its distro', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    mkdirSync(wslManagedHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(wslManagedHomePath, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: `header.${Buffer.from(JSON.stringify({ email: 'old@example.com' })).toString(
            'base64url'
          )}.signature`
        }
      }),
      'utf-8'
    )

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      return ''
    })
    let clearSelectionDuringLogin = (): void => {}
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Ubuntu', wslLinuxHomePath))
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      clearSelectionDuringLogin()
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: `header.${Buffer.from(JSON.stringify({ email: 'new@example.com' })).toString(
              'base64url'
            )}.signature`
          }
        }),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
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
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'account-1' }
      }
    })
    const store = createStore(settings)
    clearSelectionDuringLogin = () => {
      const current = store.getSettings()
      store.updateSettings({
        activeCodexManagedAccountIdsByRuntime: {
          ...current.activeCodexManagedAccountIdsByRuntime!,
          wsl: { Ubuntu: null }
        }
      })
    }
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.reauthenticateAccount('account-1')

      expect(result.accounts[0]).toMatchObject({
        email: 'new@example.com',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(result.activeAccountId).toBe(null)
      expect(result.activeAccountIdsByRuntime).toEqual({
        host: null,
        wsl: { Ubuntu: 'account-1' }
      })
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledWith(undefined, {
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(store.updateSettings).toHaveBeenCalledTimes(2)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('recreates the expected missing WSL managed home before reauthenticating', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      if (script.includes('mkdir -p -- "$candidate"')) {
        mkdirSync(wslManagedHomePath, { recursive: true })
        writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
        return ''
      }
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      return ''
    })
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Ubuntu', wslLinuxHomePath))
      expect(readFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'utf-8')).toBe(
        'account-1\n'
      )
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        createCodexAuthJson('new-wsl@example.com', 'provider-wsl-1', 'refresh-token'),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old-wsl@example.com',
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
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.reauthenticateAccount('account-1')

      expect(result.accounts[0]).toMatchObject({
        email: 'new-wsl@example.com',
        providerAccountId: 'provider-wsl-1',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('removes a WSL managed account only after canonical path validation', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    mkdirSync(wslManagedHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn((_command: string, args: string[]) => {
        const script = decodeEncodedWslBashCommand(String(args.at(-1)))
        if (script.includes('readlink -f')) {
          expect(script).toContain("expected_marker='account-1'")
          expect(script).toContain(
            'test "$candidate_real" = "$managed_root_real/$expected_marker/home"'
          )
          expect(script).toContain(
            'test "$(cat "$candidate_real/.orca-managed-home")" = "$expected_marker"'
          )
          return `${wslLinuxHomePath}\n`
        }
        return ''
      }),
      spawn: vi.fn()
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
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
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.removeAccount('account-1')

      expect(result.accounts).toHaveLength(0)
      expect(existsSync(wslManagedHomePath)).toBe(false)
      expect(existsSync(join(testState.userDataDir, 'wsl-account'))).toBe(false)
      expect(rateLimits.evictInactiveCodexCache).toHaveBeenCalledWith('account-1')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('deselects active account via selectAccount(null)', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const onHostSystemDefaultSelected = vi.fn()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never,
      { onHostSystemDefaultSelected }
    )

    const result = await service.selectAccount(null)

    expect(result.activeAccountId).toBe(null)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalled()
    expect(onHostSystemDefaultSelected).toHaveBeenCalledOnce()
  })

  it('selectAccount immediately rewrites the shared runtime auth for existing terminals', async () => {
    const firstAuth = createCodexAuthJson('one@example.com', 'acct-one', 'one')
    const secondAuth = createCodexAuthJson('two@example.com', 'acct-two', 'two')
    const firstManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      firstAuth
    )
    const secondManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-2',
      '',
      secondAuth
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: firstManagedHomePath,
          providerAccountId: 'acct-one',
          workspaceLabel: null,
          workspaceAccountId: 'acct-one',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: secondManagedHomePath,
          providerAccountId: 'acct-two',
          workspaceLabel: null,
          workspaceAccountId: 'acct-two',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const runtimeHome = new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = join(testState.userDataDir, 'codex-runtime-home', 'home', 'auth.json')
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(firstAuth)

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await service.selectAccount('account-2')

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(secondAuth)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'launch'))).toBe(false)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'active'))).toBe(false)
  })

  it('keeps Windows and WSL active Codex account selections separate', async () => {
    const hostManagedHomePath = createManagedHome(
      testState.userDataDir,
      'host-account',
      '',
      '{"account":"host"}\n'
    )
    const wslManagedHomePath =
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-accounts\\wsl-account\\home'
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'host-account',
          email: 'host@example.com',
          managedHomePath: hostManagedHomePath,
          managedHomeRuntime: 'host',
          wslDistro: null,
          wslLinuxHomePath: null,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/wsl-account/home',
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'host-account',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: {}
      }
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.selectAccountForTarget('wsl-account', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(result.activeAccountId).toBe('host-account')
    expect(result.activeAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(store.getSettings().activeCodexManagedAccountId).toBe('host-account')
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
  })

  it('removes an account and cleans up managed home', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.removeAccount('account-1')

    expect(result.accounts).toHaveLength(0)
    expect(result.activeAccountId).toBe(null)
    expect(existsSync(managedHomePath)).toBe(false)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
  })

  it('refuses to remove a managed home owned by a different account', async () => {
    const otherAccountHome = createManagedHome(
      testState.userDataDir,
      'account-2',
      '',
      '{"account":"other"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: otherAccountHome,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    await service.removeAccount('account-1')

    expect(readFileSync(join(otherAccountHome, 'auth.json'), 'utf-8')).toBe('{"account":"other"}\n')
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-accounts] Refusing to remove untrusted managed home:',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('lists accounts with normalizeActiveSelection', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'nonexistent-id'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = service.listAccounts()

    expect(result.accounts).toHaveLength(1)
    expect(result.activeAccountId).toBe(null)
  })

  it('rejects paths that escape the managed accounts root', async () => {
    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.removeAccount('nonexistent')).rejects.toThrow('no longer exists')
  })

  it('serializes concurrent mutations', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const callOrder: string[] = []
    const rateLimits = {
      refreshForCodexAccountChange: vi.fn(async () => {
        callOrder.push('refresh')
      }),
      evictInactiveCodexCache: vi.fn()
    }
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const p1 = service.selectAccount('account-1')
    const p2 = service.selectAccount(null)
    await Promise.all([p1, p2])

    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(2)
  })

  it('validates a reset only after an earlier account switch leaves the mutation queue', async () => {
    const firstHome = createManagedHome(testState.userDataDir, 'account-1')
    const secondHome = createManagedHome(testState.userDataDir, 'account-2')
    const firstAccount = {
      id: 'account-1',
      email: 'first@example.com',
      managedHomePath: firstHome,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [
        firstAccount,
        {
          ...firstAccount,
          id: 'account-2',
          email: 'second@example.com',
          managedHomePath: secondHome,
          updatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    let finishRefresh: (() => void) | undefined
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: vi.fn(),
      refreshForCodexAccountChange: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve
          })
      )
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account: firstAccount,
      limits
    })!

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const selecting = service.selectAccount('account-2')
    await vi.waitFor(() => expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce())
    const resetting = service.consumeRateLimitResetCredit(
      '11111111-1111-4111-8111-111111111111',
      expectedScope
    )
    finishRefresh?.()

    await selecting
    await expect(resetting).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'accountChanged',
      scope: expectedScope
    })
    expect(rateLimits.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('singleflights concurrent same-key reset attempts and forwards the approved home and target', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const nextManagedHomePath = createManagedHome(testState.userDataDir, 'account-2')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const nextAccount = {
      ...account,
      id: 'account-2',
      email: 'next@example.com',
      managedHomePath: nextManagedHomePath,
      updatedAt: 2
    }
    const settings = createSettings({
      codexManagedAccounts: [account, nextAccount],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    let finishConsume: ((value: { outcome: 'reset'; state: RateLimitState }) => void) | undefined
    const consume = vi.fn(
      () =>
        new Promise<{ outcome: 'reset'; state: RateLimitState }>((resolve) => {
          finishConsume = resolve
        })
    )
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'

    const first = service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    const second = service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce())
    const selectingNextAccount = service.selectAccount(nextAccount.id)
    finishConsume?.({ outcome: 'reset', state })

    const resetResults = await Promise.all([first, second])
    expect(resetResults).toMatchObject([
      { outcome: 'reset', scope: expectedScope },
      { outcome: 'reset', scope: expectedScope }
    ])
    await selectingNextAccount
    expect(resetResults[0]?.codex.activeAccountId).toBe(account.id)
    expect(resetResults[0]?.rateLimits).toBe(state)
    expect(service.listAccounts().activeAccountId).toBe(nextAccount.id)
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: managedHomePath
    })
    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    ).rejects.toThrow('selected Codex account changed')
    expect(consume).toHaveBeenCalledOnce()

    await service.selectAccount(account.id)
    const settledReplay = await service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    expect(settledReplay).toMatchObject({
      outcome: 'reset',
      scope: expectedScope,
      codex: { activeAccountId: account.id }
    })
    expect(consume).toHaveBeenCalledOnce()
    await expect(
      service.consumeRateLimitResetCredit('77777777-7777-4777-8777-777777777777', expectedScope)
    ).rejects.toThrow('already attempted')
    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, {
        ...expectedScope,
        offerRevision: 'v1:different'
      })
    ).rejects.toThrow('different reset scope')
  })

  it('blocks a different key after an ambiguous provider error but lets desktop retry', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider response lost'))
      .mockResolvedValueOnce({ outcome: 'alreadyRedeemed', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const firstKey = '33333333-3333-4333-8333-333333333333'

    await expect(service.consumeRateLimitResetCredit(firstKey, expectedScope)).rejects.toThrow(
      'provider response lost'
    )
    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'alreadyRedeemed',
      state
    })
    expect(consume).toHaveBeenCalledTimes(2)
    await expect(
      service.consumeRateLimitResetCredit('44444444-4444-4444-8444-444444444444', expectedScope)
    ).rejects.toThrow('already attempted')
    await expect(
      service.consumeRateLimitResetCredit(firstKey, expectedScope)
    ).resolves.toMatchObject({ outcome: 'alreadyRedeemed', scope: expectedScope })
    expect(consume).toHaveBeenCalledTimes(2)
  })

  it('hydrates a pending attempt after restart and replays it without current-offer CAS', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const firstConsume = vi.fn().mockRejectedValue(new Error('provider response lost'))
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: firstConsume
      } as never,
      createRuntimeHome() as never
    )
    const key = '88888888-8888-4888-8888-888888888888'

    await expect(firstService.consumeRateLimitResetCredit(key, expectedScope)).rejects.toThrow(
      'provider response lost'
    )
    state.codex = {
      ...limits,
      updatedAt: limits.updatedAt + 1,
      rateLimitResetCredits: { ...limits.rateLimitResetCredits!, availableCount: 0 }
    }
    const replayConsume = vi.fn().mockResolvedValue({ outcome: 'alreadyRedeemed', state })
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: replayConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(
      restarted.consumeRateLimitResetCredit('99999999-9999-4999-8999-999999999999', expectedScope)
    ).rejects.toThrow('unknown outcome')
    await expect(
      restarted.consumeRateLimitResetCredit(key, {
        ...expectedScope,
        offerRevision: 'v1:different'
      })
    ).rejects.toThrow('different reset scope')
    await expect(restarted.consumeRateLimitResetCredit(key, expectedScope)).resolves.toMatchObject({
      outcome: 'alreadyRedeemed',
      scope: expectedScope
    })
    expect(replayConsume).toHaveBeenCalledOnce()
  })

  it('replays a settled outcome after restart without calling the provider', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const firstConsume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: firstConsume
      } as never,
      createRuntimeHome() as never
    )
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await firstService.consumeRateLimitResetCredit(key, expectedScope)

    const replayConsume = vi.fn()
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: replayConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(restarted.consumeRateLimitResetCredit(key, expectedScope)).resolves.toMatchObject({
      outcome: 'reset',
      scope: expectedScope
    })
    await expect(
      restarted.consumeRateLimitResetCredit('abababab-abab-4bab-8bab-abababababab', expectedScope)
    ).rejects.toThrow('already attempted')
    expect(replayConsume).not.toHaveBeenCalled()
  })

  it('never calls the provider when the pending durability barrier fails', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const consume = vi.fn()
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    await expect(
      service.consumeRateLimitResetCredit('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedScope)
    ).rejects.toThrow('disk full')
    expect(consume).not.toHaveBeenCalled()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
  })

  it('keeps disk pending when settle persistence fails and recovers with the same key', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const persist = store.replaceCodexResetCreditAttemptLedgerAndFlush.getMockImplementation()!
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation((ledger) => {
      if (ledger.attempts[0]?.state === 'settled') {
        throw new Error('settle disk full')
      }
      persist(ledger)
    })
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const firstConsume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: firstConsume
      } as never,
      createRuntimeHome() as never
    )
    const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    await expect(firstService.consumeRateLimitResetCredit(key, expectedScope)).rejects.toThrow(
      'settle disk full'
    )
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])

    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation(persist)
    const replayConsume = vi.fn().mockResolvedValue({ outcome: 'alreadyRedeemed', state })
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: replayConsume
      } as never,
      createRuntimeHome() as never
    )
    await expect(restarted.consumeRateLimitResetCredit(key, expectedScope)).resolves.toMatchObject({
      outcome: 'alreadyRedeemed'
    })
    expect(replayConsume).toHaveBeenCalledOnce()
  })

  it('fails only reset operations closed when the durable ledger is corrupt', async () => {
    const settings = createSettings()
    const store = createStore(settings)
    store.getCodexResetCreditAttemptLedger.mockImplementation(() => {
      throw new Error('Codex reset-credit attempt ledger is corrupt')
    })
    const consume = vi.fn()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    expect(service.listAccounts()).toMatchObject({ accounts: [] })
    await expect(
      service.consumeRateLimitResetCredit('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
        target: { runtime: 'host', wslDistro: null },
        accountId: 'account-host',
        accountRevision: 1,
        offerRevision: 'v1:offer'
      })
    ).rejects.toThrow('Codex reset-credit attempt ledger is corrupt')
    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow(
      'Codex reset-credit attempt ledger is corrupt'
    )
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects a stale offer scope before calling the provider and permits a corrected retry key', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )
    const idempotencyKey = '55555555-5555-4555-8555-555555555555'

    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, {
        ...expectedScope,
        offerRevision: 'v1:stale'
      })
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: { ...expectedScope, offerRevision: 'v1:stale' },
      codex: { activeAccountId: account.id },
      rateLimits: state
    })
    expect(consume).not.toHaveBeenCalled()

    await expect(
      service.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    ).resolves.toMatchObject({ outcome: 'reset' })
    expect(consume).toHaveBeenCalledOnce()
  })

  it('isolates a WSL reset to the selected distro account and immutable managed home', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-wsl')
    const account = {
      id: 'account-wsl',
      email: 'wsl@example.com',
      managedHomePath,
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: account.id }
      }
    })
    const limits = createResetCreditLimits()
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const state = createResetRateLimitState(limits, target)
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({ target, account, limits })!
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      createRuntimeHome() as never
    )

    await expect(
      service.consumeRateLimitResetCredit('66666666-6666-4666-8666-666666666666', expectedScope)
    ).resolves.toMatchObject({ scope: expectedScope })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
      target,
      codexHomePath: managedHomePath
    })
  })

  it('keeps a restarted pending WSL attempt isolated from another distro', async () => {
    const ubuntuHome = createManagedHome(testState.userDataDir, 'account-ubuntu')
    const debianHome = createManagedHome(testState.userDataDir, 'account-debian')
    const ubuntu = {
      id: 'account-ubuntu',
      email: 'ubuntu@example.com',
      managedHomePath: ubuntuHome,
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const debian = {
      ...ubuntu,
      id: 'account-debian',
      email: 'debian@example.com',
      managedHomePath: debianHome,
      wslDistro: 'Debian',
      updatedAt: 2
    }
    const settings = createSettings({
      codexManagedAccounts: [ubuntu, debian],
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: ubuntu.id, Debian: debian.id }
      }
    })
    const limits = createResetCreditLimits()
    const ubuntuTarget = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const debianTarget = { runtime: 'wsl' as const, wslDistro: 'Debian' }
    const state = createResetRateLimitState(limits, ubuntuTarget)
    const ubuntuScope = buildCodexResetCreditExpectedScope({
      target: ubuntuTarget,
      account: ubuntu,
      limits
    })!
    const debianScope = buildCodexResetCreditExpectedScope({
      target: debianTarget,
      account: debian,
      limits
    })!
    const store = createStore(settings)
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: vi
          .fn()
          .mockRejectedValue(new Error('Ubuntu response lost'))
      } as never,
      createRuntimeHome() as never
    )
    await expect(
      firstService.consumeRateLimitResetCredit('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ubuntuScope)
    ).rejects.toThrow('Ubuntu response lost')

    state.codexTarget = debianTarget
    const debianConsume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: debianConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(
      restarted.consumeRateLimitResetCredit('ffffffff-ffff-4fff-8fff-ffffffffffff', debianScope)
    ).resolves.toMatchObject({ outcome: 'reset', scope: debianScope })
    expect(debianConsume).toHaveBeenCalledWith({
      idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      target: debianTarget,
      codexHomePath: debianHome
    })
  })

  it('preserves desktop reset support for the system-default Codex account', async () => {
    const settings = createSettings()
    const state = createResetRateLimitState(createResetCreditLimits())
    const consume = vi.fn().mockResolvedValue({ outcome: 'noCredit', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const runtimeHome = createRuntimeHome()
    runtimeHome.prepareForRateLimitFetch.mockReturnValue(null)
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'noCredit'
    })
    expect(runtimeHome.prepareForRateLimitFetch).toHaveBeenCalledWith({
      runtime: 'host',
      wslDistro: null
    })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: null
    })
  })

  it('routes a managed desktop reset through the durable coordinator', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toEqual({
      outcome: 'reset',
      state
    })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: managedHomePath
    })
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { state: 'settled', outcome: 'reset', expectedScope: { accountId: account.id } }
    ])
  })

  it('reuses the durable pending key when desktop retries a managed reset after restart', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const store = createStore(settings)
    const firstConsume = vi.fn().mockRejectedValue(new Error('provider response lost'))
    const { CodexAccountService } = await import('./service')
    const firstService = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: firstConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(firstService.consumeCurrentRateLimitResetCredit()).rejects.toThrow(
      'provider response lost'
    )
    const pending = store.getCodexResetCreditAttemptLedger().attempts[0]
    expect(pending).toMatchObject({
      state: 'providerPending',
      expectedScope: { accountId: account.id }
    })

    state.codex = {
      ...limits,
      updatedAt: limits.updatedAt + 1,
      rateLimitResetCredits: { ...limits.rateLimitResetCredits!, availableCount: 0 }
    }
    const replayConsume = vi.fn().mockResolvedValue({ outcome: 'alreadyRedeemed', state })
    const restarted = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: replayConsume
      } as never,
      createRuntimeHome() as never
    )

    await expect(restarted.consumeCurrentRateLimitResetCredit()).resolves.toEqual({
      outcome: 'alreadyRedeemed',
      state
    })
    expect(replayConsume).toHaveBeenCalledWith({
      idempotencyKey: pending?.idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: managedHomePath
    })
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { state: 'settled', outcome: 'alreadyRedeemed' }
    ])
  })

  it('blocks the system-default fallback while the exact target has a pending attempt', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: null
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: '12121212-1212-4212-8212-121212121212',
          expectedScope,
          state: 'providerPending'
        }
      ]
    })
    const consume = vi.fn()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow('unknown outcome')
    expect(consume).not.toHaveBeenCalled()
  })

  it('unwedges the system-default reset after removing the account owning a pending attempt', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: null
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: '12121212-1212-4212-8212-121212121212',
          expectedScope,
          state: 'providerPending'
        }
      ]
    })
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )

    // The orphan pending attempt wedges the target-scoped default reset until removal.
    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow('unknown outcome')

    await service.removeAccount('account-1')

    await expect(service.consumeCurrentRateLimitResetCredit()).resolves.toEqual({
      outcome: 'reset',
      state
    })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
  })

  it('keeps reset attempts fail-closed when removal cannot persist their purge', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
    const account = {
      id: 'account-1',
      email: 'user@example.com',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: null
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    store.replaceCodexResetCreditAttemptLedgerAndFlush({
      version: 1,
      attempts: [
        {
          idempotencyKey: '13131313-1313-4313-8313-131313131313',
          expectedScope,
          state: 'providerPending'
        }
      ]
    })
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      createRuntimeHome() as never
    )
    vi.spyOn(store, 'replaceCodexResetCreditAttemptLedgerAndFlush').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(service.removeAccount('account-1')).rejects.toThrow('disk full')
    await expect(service.consumeCurrentRateLimitResetCredit()).rejects.toThrow('unknown outcome')
    expect(consume).not.toHaveBeenCalled()
  })

  it('does not reset a different system-default target after waiting in the mutation queue', async () => {
    const settings = createSettings()
    const state = createResetRateLimitState(createResetCreditLimits())
    let finishRefresh: (() => void) | undefined
    const consume = vi.fn()
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume,
      refreshForCodexAccountChange: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve
          })
      )
    }
    const runtimeHome = createRuntimeHome()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      rateLimits as never,
      runtimeHome as never
    )

    const queueBlocker = service.selectAccount(null)
    await vi.waitFor(() => expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce())
    const resetting = service.consumeCurrentRateLimitResetCredit()
    state.codexTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    finishRefresh?.()

    await queueBlocker
    await expect(resetting).rejects.toThrow('target changed')
    expect(consume).not.toHaveBeenCalled()
    expect(runtimeHome.prepareForRateLimitFetch).not.toHaveBeenCalled()
  })

  it('removes command listeners when Codex login times out', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    try {
      const settings = createSettings()
      const store = createStore(settings)
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )
      const loginPromise = (
        service as unknown as {
          runCodexLogin(managedHomePath: string): Promise<void>
        }
      ).runCodexLogin(testState.fakeHomeDir)
      const rejection = expect(loginPromise).rejects.toThrow(
        'Codex sign-in took too long to finish.'
      )

      await vi.advanceTimersByTimeAsync(120_000)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('force-kills a lingering Windows codex login tree once auth.json exists', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
      pid: number
      exitCode: number | null
      signalCode: string | null
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    child.pid = 4242
    child.exitCode = null
    child.signalCode = null
    const execFileSyncMock = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    try {
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )
      const loginPromise = (
        service as unknown as {
          runCodexLogin(managedHomePath: string): Promise<void>
        }
      ).runCodexLogin(testState.fakeHomeDir)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(execFileSyncMock).not.toHaveBeenCalled()

      // Codex finishes the login (auth.json exists) but never exits on its own.
      writeFileSync(
        join(testState.fakeHomeDir, 'auth.json'),
        createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
        'utf-8'
      )
      await vi.advanceTimersByTimeAsync(6_000)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4242', '/t', '/f'],
        expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
      )
      expect(child.kill).not.toHaveBeenCalled()

      // The forced non-zero exit still counts as a successful login.
      child.emit('close', 1)
      await expect(loginPromise).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('waits for reauthentication to replace existing Windows auth before killing login', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
      pid: number
      exitCode: number | null
      signalCode: string | null
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    child.pid = 4343
    child.exitCode = null
    child.signalCode = null
    const execFileSyncMock = vi.fn()
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: vi.fn(() => child)
    }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const authPath = join(testState.fakeHomeDir, 'auth.json')
    writeFileSync(
      authPath,
      createCodexAuthJson('user@example.com', 'provider-account-1', 'old-token'),
      'utf-8'
    )

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )
      const loginPromise = (
        service as unknown as { runCodexLogin(managedHomePath: string): Promise<void> }
      ).runCodexLogin(testState.fakeHomeDir)

      await vi.advanceTimersByTimeAsync(6_000)
      expect(execFileSyncMock).not.toHaveBeenCalled()

      writeFileSync(
        authPath,
        createCodexAuthJson('user@example.com', 'provider-account-1', 'new-token'),
        'utf-8'
      )
      await vi.advanceTimersByTimeAsync(6_000)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4343', '/t', '/f'],
        expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
      )

      child.emit('close', 1)
      await expect(loginPromise).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('removes managed homes with bounded rm retries for transient Windows locks', async () => {
    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
    const rmSyncSpy = vi.fn(actualFs.rmSync)
    vi.doMock('node:fs', () => ({ ...actualFs, rmSync: rmSyncSpy }))

    try {
      // Why realpath: assertManagedHomePath canonicalizes before rmSync, so the
      // spy sees /private/var-style paths on macOS.
      const managedHomePath = actualFs.realpathSync(
        createManagedHome(testState.userDataDir, 'account-1')
      )
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      ;(
        service as unknown as {
          safeRemoveManagedHome(candidatePath: string, expectedAccountId: string): void
        }
      ).safeRemoveManagedHome(managedHomePath, 'account-1')

      expect(existsSync(managedHomePath)).toBe(false)
      const homeRemoval = rmSyncSpy.mock.calls.find(([target]) => target === managedHomePath)
      expect(homeRemoval?.[1]).toMatchObject({
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150
      })
    } finally {
      vi.doUnmock('node:fs')
    }
  })

  it('does not throw when managed home removal keeps failing on a held handle', async () => {
    vi.resetModules()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
    let managedHomePath = ''
    const lockedError = Object.assign(new Error('ENOTEMPTY: directory not empty'), {
      code: 'ENOTEMPTY'
    })
    const rmSyncSpy = vi.fn((target: Parameters<typeof actualFs.rmSync>[0], options) => {
      if (target === managedHomePath) {
        throw lockedError
      }
      actualFs.rmSync(target, options)
    })
    vi.doMock('node:fs', () => ({ ...actualFs, rmSync: rmSyncSpy }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      managedHomePath = actualFs.realpathSync(createManagedHome(testState.userDataDir, 'account-1'))
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      expect(() =>
        (
          service as unknown as {
            safeRemoveManagedHome(candidatePath: string, expectedAccountId: string): void
          }
        ).safeRemoveManagedHome(managedHomePath, 'account-1')
      ).not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(
        '[codex-accounts] Failed to remove managed home:',
        lockedError
      )
    } finally {
      warnSpy.mockRestore()
      vi.doUnmock('node:fs')
    }
  })

  describe('system-default identity', () => {
    const systemCodexHomeDir = () => join(testState.fakeHomeDir, '.codex')
    const systemAuthPath = () => join(systemCodexHomeDir(), 'auth.json')

    async function newService() {
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      return new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)
    }

    function withoutEnvApiKey<T>(run: () => T): T {
      const previous = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      try {
        return run()
      } finally {
        if (previous === undefined) {
          delete process.env.OPENAI_API_KEY
        } else {
          process.env.OPENAI_API_KEY = previous
        }
      }
    }

    it('reports the real ~/.codex OAuth identity for the system default', async () => {
      writeFileSync(
        systemAuthPath(),
        createCodexAuthJson('real@home.dev', 'acct-real', 'refresh-real'),
        'utf-8'
      )
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.activeAccountId).toBeNull()
      expect(state.systemDefault).toEqual({
        hasAuth: true,
        authKind: 'oauth',
        email: 'real@home.dev',
        providerAccountId: 'acct-real',
        workspaceLabel: null
      })
    })

    it('reports an api-key auth.json as a custom provider with no identity', async () => {
      writeFileSync(systemAuthPath(), JSON.stringify({ OPENAI_API_KEY: 'sk-live-test' }), 'utf-8')
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.systemDefault).toEqual({
        hasAuth: true,
        authKind: 'api-key',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })

    it('reports signed-out when no auth.json and no env key is present', async () => {
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.systemDefault).toEqual({
        hasAuth: false,
        authKind: 'none',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })

    it('degrades safely when auth.json contains valid JSON with the wrong shape', async () => {
      writeFileSync(systemAuthPath(), 'null', 'utf-8')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const service = await newService()

      try {
        const state = withoutEnvApiKey(() => service.listAccounts())

        expect(state.systemDefault).toEqual({
          hasAuth: true,
          authKind: 'none',
          email: null,
          providerAccountId: null,
          workspaceLabel: null
        })
        expect(warn).toHaveBeenCalledWith(
          '[codex-accounts] System-default Codex auth has an unexpected format'
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('fails a corrupt managed auth.json without echoing credential bytes', async () => {
      const secret = 'sk-managed-secret-never-log'
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        '',
        `{"tokens": {"refresh_token": "${secret}"`
      )
      const service = await newService()

      let thrown: Error | null = null
      try {
        ;(
          service as unknown as {
            readIdentityFromHome(managedHomePath: string, expectedAccountId: string): unknown
          }
        ).readIdentityFromHome(managedHomePath, 'account-1')
      } catch (error) {
        thrown = error as Error
      }

      expect(thrown).not.toBeNull()
      expect(thrown!.message).toBe('Codex auth.json is corrupt or not valid JSON')
      expect(thrown!.message).not.toContain(secret)
    })

    it('does not log auth contents when auth.json is malformed', async () => {
      const secret = 'sk-secret-review-never-log'
      writeFileSync(systemAuthPath(), secret, 'utf-8')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const service = await newService()

      try {
        const state = withoutEnvApiKey(() => service.listAccounts())

        expect(state.systemDefault?.authKind).toBe('none')
        expect(warn).toHaveBeenCalledWith(
          '[codex-accounts] System-default Codex auth is not valid JSON'
        )
        expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
      } finally {
        warn.mockRestore()
      }
    })

    it('reports an env OPENAI_API_KEY (no auth.json) as a custom provider', async () => {
      const service = await newService()
      const previous = process.env.OPENAI_API_KEY
      process.env.OPENAI_API_KEY = 'sk-env-test'
      try {
        const state = service.listAccounts()
        expect(state.systemDefault).toEqual({
          hasAuth: false,
          authKind: 'api-key',
          email: null,
          providerAccountId: null,
          workspaceLabel: null
        })
      } finally {
        if (previous === undefined) {
          delete process.env.OPENAI_API_KEY
        } else {
          process.env.OPENAI_API_KEY = previous
        }
      }
    })

    it('never mutates ~/.codex when selecting or deselecting a managed account', async () => {
      const systemAuth = createCodexAuthJson('real@home.dev', 'acct-real', 'refresh-real')
      writeFileSync(systemAuthPath(), systemAuth, 'utf-8')
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        'approval_policy = "on-request"\n',
        createCodexAuthJson('managed@example.com', 'acct-managed', 'refresh-managed')
      )
      const store = createStore(
        createSettings({
          codexManagedAccounts: [
            {
              id: 'account-1',
              email: 'managed@example.com',
              managedHomePath,
              providerAccountId: 'acct-managed',
              workspaceLabel: null,
              workspaceAccountId: 'acct-managed',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await service.selectAccount('account-1')
      await service.selectAccount(null)

      expect(readFileSync(systemAuthPath(), 'utf-8')).toBe(systemAuth)
      const state = withoutEnvApiKey(() => service.listAccounts())
      expect(state.systemDefault?.email).toBe('real@home.dev')
    })
  })

  // Why: quota probes against a cold per-account CODEX_HOME can take 10–25s
  // (RPC + PTY fallback) and queue behind an in-flight global usage refresh;
  // account mutations must never block on — or fail because of — that probe.
  describe('quota refresh decoupling', () => {
    function createAccountOneSettings(): GlobalSettings {
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        '',
        '{"account":"managed"}\n'
      )
      return createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ]
      })
    }

    async function expectResolvesPromptly<T>(promise: Promise<T>, label: string): Promise<T> {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} blocked on the quota refresh`)),
              2_000
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    function createLoginSpawnMock() {
      return vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()
        writeFileSync(
          join(options.env.CODEX_HOME!, 'auth.json'),
          createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
          'utf-8'
        )
        queueMicrotask(() => child.emit('close', 0))
        return child
      })
    }

    it('resolves selectAccount while the quota refresh never settles', async () => {
      const store = createStore(createAccountOneSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn(() => new Promise<never>(() => {})),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await expectResolvesPromptly(
        service.selectAccount('account-1'),
        'selectAccount'
      )

      expect(state.activeAccountId).toBe('account-1')
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(1)
    })

    it('resolves selectAccount when the quota refresh rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = createStore(createAccountOneSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn().mockRejectedValue(new Error('cold probe failed')),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await service.selectAccount('account-1')

      expect(state.activeAccountId).toBe('account-1')
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
      errorSpy.mockRestore()
    })

    it('resolves addAccount while the post-login quota refresh never settles', async () => {
      vi.resetModules()
      writeFileSync(
        join(testState.fakeHomeDir, '.codex', 'config.toml'),
        'approval_policy = "never"\n',
        'utf-8'
      )
      const spawnMock = createLoginSpawnMock()
      vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
      vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

      const store = createStore(createSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn(() => new Promise<never>(() => {})),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await expectResolvesPromptly(service.addAccount(), 'addAccount')

      expect(state.accounts).toHaveLength(1)
      expect(state.accounts[0].email).toBe('user@example.com')
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(1)
    })

    it('keeps the new account and its managed home when the post-login quota refresh rejects', async () => {
      vi.resetModules()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      writeFileSync(
        join(testState.fakeHomeDir, '.codex', 'config.toml'),
        'approval_policy = "never"\n',
        'utf-8'
      )
      const spawnMock = createLoginSpawnMock()
      vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
      vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

      const store = createStore(createSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn().mockRejectedValue(new Error('cold probe failed')),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await service.addAccount()

      expect(state.accounts).toHaveLength(1)
      const account = store.getSettings().codexManagedAccounts[0]
      expect(account.email).toBe('user@example.com')
      // The durable mutation must survive a failed usage probe — previously the
      // rejection fell into login cleanup and deleted the just-created home.
      expect(existsSync(account.managedHomePath)).toBe(true)
      expect(existsSync(join(account.managedHomePath, 'auth.json'))).toBe(true)
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
      errorSpy.mockRestore()
    })
  })
})
