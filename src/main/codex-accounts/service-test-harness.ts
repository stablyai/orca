import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
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
  const appFontFamily = overrides.appFontFamily ?? 'Geist'
  const agentStatusHooksEnabled = overrides.agentStatusHooksEnabled ?? true
  const tabAutoGenerateTitle = overrides.tabAutoGenerateTitle ?? false
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
    terminalFontWeightBold: 700,
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
    pluginSystemEnabled: false,
    disabledPlugins: [],
    pluginConsents: {},
    devPluginPaths: [],
    skipDeleteWorktreeConfirm: false,
    skipCloseTerminalWithRunningProcessConfirm: false,
    skipDeleteAutomationConfirm: false,
    skipDeleteArtifactConfirm: false,
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
    ...overrides,
    diffWordWrap: overrides.diffWordWrap ?? false,
    localWindowsRuntimeDefault: overrides.localWindowsRuntimeDefault ?? { kind: 'windows-host' },
    leftSidebarAppearanceMode: overrides.leftSidebarAppearanceMode ?? 'default',
    appFontFamily,
    agentStatusHooksEnabled,
    tabAutoGenerateTitle
  }
}

export function createStore(settings: GlobalSettings) {
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
    prepareForRateLimitFetch: vi.fn(
      (): CodexRateLimitHomeResolution => ({ kind: 'ready', codexHomePath: null })
    )
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
