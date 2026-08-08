/* eslint-disable max-lines -- test suite covers snapshot, migration, auth materialization, and error-resilience scenarios */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'
import type * as ShellStartupEnv from '../pty/shell-startup-env'

const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  previousUserDataPath: undefined as string | undefined,
  shellStartupEnvProbeSupported: true
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

// Why: the shared system-default mirror is still live wherever the shell-startup
// probe is unavailable (Windows), so drive this suite's lane coverage and
// mid-test flips through that real gate rather than a test-only override.
type TestSettingsOverrides = Partial<GlobalSettings> & {
  shellStartupEnvProbeSupported?: boolean
}

function setShellStartupEnvProbeSupportedForTest(enabled: boolean): void {
  testState.shellStartupEnvProbeSupported = enabled
}

function createSettings(overrides: TestSettingsOverrides = {}): GlobalSettings {
  const appFontFamily = overrides.appFontFamily ?? 'Geist'
  const agentStatusHooksEnabled = overrides.agentStatusHooksEnabled ?? true
  const tabAutoGenerateTitle = overrides.tabAutoGenerateTitle ?? false
  // Mirror-path tests assert the shared runtime home, which production still uses
  // on Windows; opt these cases onto that lane unless a test overrides it.
  setShellStartupEnvProbeSupportedForTest(overrides.shellStartupEnvProbeSupported ?? false)
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
    pluginSystemEnabled: false,
    disabledPlugins: [],
    pluginConsents: {},
    devPluginPaths: [],
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

function getSystemCodexHomePath(): string {
  return join(testState.fakeHomeDir, '.codex')
}

function getSystemCodexAuthPath(): string {
  return join(getSystemCodexHomePath(), 'auth.json')
}

function getRuntimeCodexHomePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'home')
}

function getRuntimeCodexAuthPath(): string {
  return join(getRuntimeCodexHomePath(), 'auth.json')
}

function getSharedRuntimeAuthProvenancePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'shared-runtime-auth-provenance.json')
}

function writePaneRegistry(
  panes: Record<string, { selectionKey: string; accountId: string | null; homeRoute?: string }>
): void {
  writeFileSync(
    join(testState.userDataDir, 'codex-pane-accounts.json'),
    `${JSON.stringify({ version: 2, panes })}\n`,
    'utf-8'
  )
}

function getLegacyActiveHostCodexHomePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'active', 'host', 'home')
}

function normalizeLinkTarget(linkTarget: string): string {
  return process.platform === 'win32'
    ? linkTarget.replace(/^\\\\\?\\/, '').toLowerCase()
    : linkTarget
}

function expectResourceLinkedOrCopied(targetPath: string, sourcePath: string): void {
  expect(existsSync(targetPath)).toBe(true)
  if (!lstatSync(targetPath).isSymbolicLink()) {
    return
  }
  expect(normalizeLinkTarget(readlinkSync(targetPath))).toBe(normalizeLinkTarget(sourcePath))
}

function createStore(settings: GlobalSettings) {
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

function createManagedAuth(rootDir: string, accountId: string, auth: string): string {
  const managedHomePath = join(rootDir, 'codex-accounts', accountId, 'home')
  mkdirSync(managedHomePath, { recursive: true })
  writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
  writeFileSync(join(managedHomePath, 'auth.json'), auth, 'utf-8')
  return managedHomePath
}

function createCodexAccountRecord(
  id: string,
  email: string,
  providerAccountId: string,
  managedHomePath: string
): CodexManagedAccount {
  return {
    id,
    email,
    managedHomePath,
    providerAccountId,
    workspaceLabel: null,
    workspaceAccountId: providerAccountId,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function createCodexAuthJson(
  email: string,
  accountId: string,
  refreshToken: string,
  expiresAt?: number,
  lastRefresh?: string
): string {
  const idToken = [
    encodeJwtPart({ alg: 'none', typ: 'JWT' }),
    encodeJwtPart({
      email,
      ...(expiresAt === undefined ? {} : { exp: expiresAt }),
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        workspace_account_id: accountId
      }
    }),
    ''
  ].join('.')

  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    ...(lastRefresh === undefined ? {} : { last_refresh: lastRefresh }),
    tokens: {
      access_token: `access-${accountId}`,
      id_token: idToken,
      account_id: accountId,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      refresh_token: refreshToken
    }
  })}\n`
}

describe('CodexRuntimeHomeService', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    testState.shellStartupEnvProbeSupported = true
    vi.doMock('../pty/shell-startup-env', async () => ({
      ...(await vi.importActual<typeof ShellStartupEnv>('../pty/shell-startup-env')),
      isShellStartupEnvProbeSupported: () => testState.shellStartupEnvProbeSupported
    }))
    testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-runtime-home-'))
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
    testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = testState.userDataDir
    mkdirSync(getSystemCodexHomePath(), { recursive: true })
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writePaneRegistry({
      'retained-shared-pane': {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home'
      }
    })
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

  it('captures the existing ~/.codex auth as the system-default snapshot', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(true)
    if (process.platform !== 'win32') {
      expect(
        statSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
          .mode & 0o777
      ).toBe(0o600)
    }
  })

  it('refuses to read runtime auth back into a duplicate account while a home is unreadable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('system@example.com', 'acct-system', 'system'),
      'utf-8'
    )
    const authX = createCodexAuthJson('x@example.com', 'acct-x', 'x', 1)
    const authXRefreshed = createCodexAuthJson('x@example.com', 'acct-x', 'x-refreshed', 2)
    // Two records for the same identity: one home unreadable, one readable.
    const homeX1 = createManagedAuth(testState.userDataDir, 'account-x1', authX)
    const homeX2 = createManagedAuth(testState.userDataDir, 'account-x2', authX)
    const homeB = createManagedAuth(
      testState.userDataDir,
      'account-b',
      createCodexAuthJson('b@example.com', 'acct-b', 'b')
    )
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(runtimeAuthPath, authXRefreshed, 'utf-8')
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({ owner: 'managed', accountId: 'account-x1' })}\n`,
      'utf-8'
    )
    chmodSync(join(homeX1, 'auth.json'), 0o000)
    rmSync(join(homeB, 'auth.json'), { force: true })
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-x1', 'x@example.com', 'acct-x', homeX1),
          createCodexAccountRecord('account-x2', 'x@example.com', 'acct-x', homeX2),
          createCodexAccountRecord('account-b', 'b@example.com', 'acct-b', homeB)
        ],
        activeCodexManagedAccountId: 'account-b',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-b', wsl: {} }
      })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(homeX2, 'auth.json'), 'utf-8')).toBe(authX)
  })

  it('keeps the mirror of a renamed account whose record email is stale', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('system@example.com', 'acct-system', 'system'),
      'utf-8'
    )
    const renamedAuth = createCodexAuthJson('new@example.com', 'acct-user', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', renamedAuth)
    // Torn provenance can no longer vouch for the mirror, and the only remaining
    // evidence is a credential whose email no longer matches the record.
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(runtimeAuthPath, renamedAuth, 'utf-8')
    writeFileSync(getSharedRuntimeAuthProvenancePath(), 'not-json', 'utf-8')
    writeFileSync(join(managedHomePath, 'auth.json'), '{"tokens":{"acc', 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'old@example.com', 'acct-user', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(renamedAuth)
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBe('account-1')
  })

  it('repoints legacy active host CODEX_HOME to the shared runtime home on startup', async () => {
    const legacyLaunchHomePath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'launch',
      'host',
      'account-old',
      'home'
    )
    const legacyActiveHomePath = getLegacyActiveHostCodexHomePath()
    mkdirSync(legacyLaunchHomePath, { recursive: true })
    mkdirSync(join(legacyActiveHomePath, '..'), { recursive: true })
    symlinkSync(
      legacyLaunchHomePath,
      legacyActiveHomePath,
      process.platform === 'win32' ? 'junction' : undefined
    )
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(normalizeLinkTarget(readlinkSync(legacyActiveHomePath))).toBe(
      normalizeLinkTarget(getRuntimeCodexHomePath())
    )
    expect(readFileSync(join(legacyActiveHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"system"}\n'
    )
  })

  it('uses the canonical Electron userData for legacy active host migration', async () => {
    const staleUserDataDir = mkdtempSync(join(tmpdir(), 'orca-stale-runtime-home-'))
    const staleRuntimeHomePath = join(staleUserDataDir, 'codex-runtime-home', 'home')
    try {
      mkdirSync(staleRuntimeHomePath, { recursive: true })
      process.env.ORCA_USER_DATA_PATH = staleUserDataDir
      const legacyLaunchHomePath = join(
        testState.userDataDir,
        'codex-runtime-home',
        'launch',
        'host',
        'account-old',
        'home'
      )
      const legacyActiveHomePath = getLegacyActiveHostCodexHomePath()
      mkdirSync(legacyLaunchHomePath, { recursive: true })
      mkdirSync(join(legacyActiveHomePath, '..'), { recursive: true })
      symlinkSync(
        legacyLaunchHomePath,
        legacyActiveHomePath,
        process.platform === 'win32' ? 'junction' : undefined
      )
      writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
      const store = createStore(createSettings())

      const { configureOrcaUserDataPathEnv } = await import('../startup/configure-process')
      configureOrcaUserDataPathEnv()
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      new CodexRuntimeHomeService(store as never)

      expect(process.env.ORCA_USER_DATA_PATH).toBe(testState.userDataDir)
      expect(normalizeLinkTarget(readlinkSync(legacyActiveHomePath))).toBe(
        normalizeLinkTarget(getRuntimeCodexHomePath())
      )
      expect(normalizeLinkTarget(readlinkSync(legacyActiveHomePath))).not.toBe(
        normalizeLinkTarget(staleRuntimeHomePath)
      )
    } finally {
      rmSync(staleUserDataDir, { recursive: true, force: true })
    }
  })

  it('does not create a legacy active host pointer for fresh shared-home users', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(existsSync(getLegacyActiveHostCodexHomePath())).toBe(false)
  })

  it('builds a valid WSL legacy active-home migration shell command', async () => {
    const execFileSyncMock = vi.fn()
    vi.doMock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(
        createStore(createSettings()) as never
      ) as unknown as {
        migrateLegacyWslActiveHomePointer(distro: string, runtimeHomePath: string): void
      }

      service.migrateLegacyWslActiveHomePointer(
        'Ubuntu',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
      )

      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      const firstCall = execFileSyncMock.mock.calls[0]
      expect(firstCall).toBeDefined()
      const [command, args] = firstCall as [string, string[]]
      expect(command).toBe('wsl.exe')
      expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lc'])
      expect(args).toHaveLength(6)

      const shellCommand = args[5]
      expect(shellCommand).toContain(
        "if [ ! -e '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ] && [ ! -L '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ]; then :"
      )
      expect(shellCommand).toContain(
        "elif [ -e '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ] && [ ! -L '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ]; then :"
      )
      expect(shellCommand).toContain(
        "mkdir -p '/home/alice/.local/share/orca/codex-runtime-home/active/wsl'"
      )
      expect(shellCommand).toContain(
        "ln -s -- '/home/alice/.local/share/orca/codex-runtime-home/home' '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home.next-"
      )
      expect(shellCommand).toContain(
        "mv -Tf -- '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home.next-"
      )
      expect(shellCommand).toContain(
        "' '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home'"
      )
      expect(shellCommand).not.toContain('[! -L')
      expect(shellCommand).not.toContain('mv -Tf--')
      expect(shellCommand).not.toContain('$1')
      expect(shellCommand).not.toContain('$2')
      expect(shellCommand).not.toContain('$3')
      expect(shellCommand).not.toContain('exit 0')
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('starts WSL session bridging after materializing the WSL launch home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const wslSystemHomePath = join(wslHome, '.codex')
    mkdirSync(wslSystemHomePath, { recursive: true })
    writeFileSync(join(wslSystemHomePath, 'AGENTS.md'), '# WSL instructions\n', 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledTimes(1)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        systemCodexHomePath: wslSystemHomePath,
        managedCodexHomePath: wslRuntimeHomePath
      })
      const runtimeAgentsPath = join(wslRuntimeHomePath, 'AGENTS.md')
      expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('# WSL instructions\n')
      expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(false)
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('promotes WSL in-Codex setting changes on the next Codex launch', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground: vi.fn(() => Promise.resolve())
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )
    const wslSystemConfigPath = join(wslHome, '.codex', 'config.toml')
    mkdirSync(join(wslHome, '.codex'), { recursive: true })
    writeFileSync(wslSystemConfigPath, 'model = "gpt-5"\n', 'utf-8')

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      // First launch seeds the runtime config and records the per-distro baseline.
      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      const baselinePath = join(wslRuntimeHomePath, '.orca-config-settings-baseline.json')
      expect(existsSync(baselinePath)).toBe(true)

      // A direct WSL Codex edit wins and is mirrored into Orca's runtime before
      // the baseline advances, so later in-Orca changes remain promotable.
      const runtimeConfigPath = join(wslRuntimeHomePath, 'config.toml')
      writeFileSync(wslSystemConfigPath, 'model = "outside-edit"\n', 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "outside-edit"\n')
      expect(readFileSync(baselinePath, 'utf-8')).toContain('"model": "\\"outside-edit\\""')

      // Codex now persists a /model change inside Orca's reconciled runtime.
      writeFileSync(
        runtimeConfigPath,
        readFileSync(runtimeConfigPath, 'utf-8').replace('model = "outside-edit"', 'model = "o4"'),
        'utf-8'
      )

      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(wslSystemConfigPath, 'utf-8')).toBe('model = "o4"\n')
      // Baseline advances so the promoted value is not re-promoted forever.
      expect(readFileSync(baselinePath, 'utf-8')).toContain('"model": "\\"o4\\""')
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('bridges WSL history from a configured per-distro source-home override', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } },
        // Why: the override is a Linux path inside the distro, not <wslHome>/.codex.
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })

      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledTimes(1)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        systemCodexHomePath: '/home/me/.config/codex',
        managedCodexHomePath: wslRuntimeHomePath
      })
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('starts WSL session bridging for the distro used by the materialized runtime home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'debian-wsl-home')
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => null,
      getWslHome: (distro: string) => (distro === 'Debian' ? wslHome : null)
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (candidate: string) =>
        candidate === wslRuntimeHomePath
          ? {
              distro: 'Debian',
              linuxPath: '/home/alice/.local/share/orca/codex-runtime-home/home'
            }
          : null
    }))
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'debian-account',
      '{"account":"debian"}\n'
    )
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'debian-account',
            email: 'debian@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Debian',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/debian/home',
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Debian: 'debian-account' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: null })).toBe(
        wslRuntimeHomePath
      )
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Debian',
        systemCodexHomePath: join(wslHome, '.codex'),
        managedCodexHomePath: wslRuntimeHomePath
      })
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      vi.doUnmock('../../shared/wsl-paths')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('restores the system-default snapshot when no managed account is selected', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
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
      activeCodexManagedAccountId: null
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    writeFileSync(runtimeAuthPath, '{"account":"managed"}\n', 'utf-8')

    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
  })

  it('removes runtime auth when deselecting with a missing system-default snapshot', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'managed')
    writeFileSync(runtimeAuthPath, managedAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('repairs a corrupt system-default snapshot from the live ~/.codex auth on deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    const snapshotPath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'system-default-auth.json'
    )
    writeFileSync(snapshotPath, '{not valid json', 'utf-8')
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
    expect(existsSync(snapshotPath)).toBe(true)
    expect(JSON.parse(readFileSync(snapshotPath, 'utf-8'))).toEqual({
      authJson: '{"account":"system"}\n'
    })
  })

  it('clears an active account selection whose self-contained home is missing', async () => {
    const missingManagedHomePath = join(
      testState.userDataDir,
      'codex-accounts',
      'account-1',
      'home'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: missingManagedHomePath,
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(warnSpy).toHaveBeenCalled()
  })

  it('clears an unknown active account id and removes untrusted runtime auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"stale-managed"}\n', 'utf-8')
    const settings = createSettings({
      activeCodexManagedAccountId: 'missing-account'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('returns the Orca-managed runtime home for Codex launch and rate-limit preparation', async () => {
    const markerPath = join(
      testState.userDataDir,
      'codex-session-backfill',
      'backfill-complete.json'
    )
    mkdirSync(join(testState.userDataDir, 'codex-session-backfill'), { recursive: true })
    writeFileSync(markerPath, '{}\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(existsSync(markerPath)).toBe(false)
    service.finishHostSystemDefaultSessionMigrationPass()
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      true
    )
    service.finishHostSystemDefaultSessionMigrationPass()
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: join(getSystemCodexHomePath(), 'sessions'),
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )
    service.prepareForCodexLaunch()
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: join(getSystemCodexHomePath(), 'sessions'),
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      false
    )
    expect(existsSync(markerPath)).toBe(false)
    service.prepareForCodexLaunch()
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      false
    )
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(null)).toBeNull()
    service.finishHostSystemDefaultSessionMigrationPass()
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: join(getSystemCodexHomePath(), 'sessions'),
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(null, { reattached: true })).toBe(
      false
    )
    expect(existsSync(markerPath)).toBe(false)
    store.updateSettings({
      codexSessionSourceHome: { host: join(testState.fakeHomeDir, 'moved-history'), wsl: {} }
    })
    service.prepareForCodexLaunch()
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      true
    )
    expect(service.prepareForRateLimitFetch()).toBe(getRuntimeCodexHomePath())
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([getRuntimeCodexHomePath()])
    expect(existsSync(getRuntimeCodexHomePath())).toBe(true)
  })

  it('routes host system default to the real home', async () => {
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.isHostSystemDefaultRealHome()).toBe(true)
    expect(service.getSelectedHostCodexHomeRoute()).toBe('real-home')
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([
      getRuntimeCodexHomePath(),
      getSystemCodexHomePath()
    ])
    service.setRealHomeLaneGate(() => false)
    expect(service.getSelectedHostCodexHomeRoute()).toBe('shared-home')
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([getRuntimeCodexHomePath()])
    const markerPath = join(
      testState.userDataDir,
      'codex-session-backfill',
      'backfill-complete.json'
    )
    mkdirSync(join(testState.userDataDir, 'codex-session-backfill'), { recursive: true })
    writeFileSync(markerPath, '{}\n', 'utf-8')
    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(existsSync(markerPath)).toBe(false)
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      true
    )
    service.finishHostSystemDefaultSessionMigrationPass()
    service.setRealHomeLaneGate(() => true)
    const perSpawnCustomHome = join(testState.fakeHomeDir, 'per-spawn-custom-codex-home')
    writeFileSync(markerPath, '{}\n', 'utf-8')
    expect(service.isHostSystemDefaultRealHome({ CODEX_HOME: perSpawnCustomHome })).toBe(false)
    expect(service.prepareForCodexLaunch(undefined, { CODEX_HOME: perSpawnCustomHome })).toBe(
      getRuntimeCodexHomePath()
    )
    expect(existsSync(markerPath)).toBe(true)
    expect(
      service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath(), {
        launchEnv: { CODEX_HOME: perSpawnCustomHome }
      })
    ).toBeNull()
    if (process.platform !== 'win32') {
      // Why: shell startup CODEX_HOME discovery is a POSIX-shell lane; Windows
      // must not invoke an ambient WSL bash while evaluating this contract.
      writeFileSync(
        join(testState.fakeHomeDir, '.zshrc'),
        'export CODEX_HOME="$HOME/shell-custom-codex-home"\n',
        'utf-8'
      )
      const shellLaunchEnv = { HOME: testState.fakeHomeDir, SHELL: '/bin/zsh' }
      expect(service.isHostSystemDefaultRealHome(shellLaunchEnv)).toBe(false)
      expect(service.prepareForCodexLaunch(undefined, shellLaunchEnv)).toBe(
        getRuntimeCodexHomePath()
      )
    }
    const previousCodexHome = process.env.CODEX_HOME
    const previousOrcaCodexHome = process.env.ORCA_CODEX_HOME
    process.env.CODEX_HOME = getRuntimeCodexHomePath()
    process.env.ORCA_CODEX_HOME = getRuntimeCodexHomePath()
    try {
      // Background fetchers prefer ambient CODEX_HOME when passed null, so an
      // explicit path proves nested Orca launches cannot poll the managed home.
      expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
      process.env.CODEX_HOME = getSystemCodexHomePath()
      delete process.env.ORCA_CODEX_HOME
      expect(service.isHostSystemDefaultRealHome()).toBe(true)
      process.env.CODEX_HOME = join(testState.fakeHomeDir, 'user-owned-codex-home')
      expect(service.isHostSystemDefaultRealHome()).toBe(false)
      expect(service.prepareForRateLimitFetch()).toBe(getRuntimeCodexHomePath())
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = previousOrcaCodexHome
      }
    }
  })

  it('seeds shared auth for a pane-local custom home on the real-home lane', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const customHome = join(testState.fakeHomeDir, 'pane-custom-codex-home')

    expect(service.prepareForCodexLaunch(undefined, { CODEX_HOME: customHome })).toBe(
      getRuntimeCodexHomePath()
    )
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('skips retired-home reconciliation when no retained host pane can use it', async () => {
    const syncLegacySharedCodexConfigForRetainedPanes = vi.fn()
    vi.doMock('./legacy-shared-config-compatibility', () => ({
      syncLegacySharedCodexConfigForRetainedPanes
    }))
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained')
    const currentAuth = createCodexAuthJson('system@example.com', 'acct-system', 'current')
    const retainedConfig = 'model = "retained"\n'
    writePaneRegistry({
      'real-home-pane': {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home'
      }
    })
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), retainedConfig, 'utf-8')
    writeFileSync(getSystemCodexAuthPath(), currentAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "current"\n', 'utf-8')
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({ owner: 'system-default', authJson: retainedAuth })}\n`,
      'utf-8'
    )
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      service.reconcileLegacySharedHomeForRetainedPanes()
      expect(service.prepareForCodexLaunch()).toBeNull()
      expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())

      expect(syncLegacySharedCodexConfigForRetainedPanes).not.toHaveBeenCalled()
      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
      expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
        retainedConfig
      )
    } finally {
      vi.doUnmock('./legacy-shared-config-compatibility')
    }
  })

  it('keeps pre-rollout shared-home panes authenticated on the real-home lane', async () => {
    const oldSystemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-system')
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const systemConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'requires_openai_auth = true',
      ''
    ].join('\n')
    writeFileSync(getSystemCodexAuthPath(), oldSystemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), systemConfig, 'utf-8')
    writeFileSync(
      join(getRuntimeCodexHomePath(), 'config.toml'),
      'model_provider = "stale-provider"\n',
      'utf-8'
    )

    const service = new CodexRuntimeHomeService(store as never)

    service.setRealHomeLaneGate(() => true)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toContain(
      'stale-provider'
    )
    service.reconcileLegacySharedHomeForRetainedPanes()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(service.prepareForCodexLaunch()).toBeNull()
  })

  it('preserves retained managed auth across a real-home main-process restart', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')

    setShellStartupEnvProbeSupportedForTest(true)
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.setRealHomeLaneGate(() => true)

    expect(restartedService.prepareForCodexLaunch()).toBeNull()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('fences retained shared auth when a self-contained managed transition begins', async () => {
    const systemAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'system')
    const managedAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'shared@example.com',
          managedHomePath,
          providerAccountId: 'acct-shared',
          workspaceLabel: null,
          workspaceAccountId: 'acct-shared',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    rmSync(getSystemCodexAuthPath())

    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(managedAuth)
  })

  it('restores retained system ownership when a self-contained transition leaves it untouched', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed'
    )
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
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
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('restores authoritative system auth when the shared lane follows a managed transition', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
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
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    setShellStartupEnvProbeSupportedForTest(false)
    service.syncForCurrentSelection()

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('refreshes untouched retained-pane auth during real-home rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('does not rewrite retained-auth provenance during unchanged rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const provenancePath = getSharedRuntimeAuthProvenancePath()
    const originalInode = statSync(provenancePath).ino

    setShellStartupEnvProbeSupportedForTest(true)
    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()

    expect(statSync(provenancePath).ino).toBe(originalInode)
  })

  it('does not rewrite completed retained logout metadata during rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    setShellStartupEnvProbeSupportedForTest(true)
    rmSync(getSystemCodexAuthPath())
    service.prepareForRateLimitFetch()
    const metadataPaths = [
      getSharedRuntimeAuthProvenancePath(),
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
    ]
    const originalInodes = metadataPaths.map((path) => statSync(path).ino)

    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()

    expect(metadataPaths.map((path) => statSync(path).ino)).toEqual(originalInodes)
  })

  it('clears managed transition state before later retained-auth reconciliation', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed-token')
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
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
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()

    writeFileSync(getRuntimeCodexAuthPath(), systemAuth, 'utf-8')
    writeFileSync(
      join(testState.userDataDir, 'codex-runtime-home', 'shared-runtime-auth-provenance.json'),
      `${JSON.stringify({ owner: 'system-default', authJson: systemAuth })}\n`
    )
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    setShellStartupEnvProbeSupportedForTest(true)
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('does not overwrite auth changed by a retained Codex process', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('applies source logout after a retained pane refreshes the same identity', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    rmSync(getSystemCodexAuthPath())

    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
  })

  it('repairs a completed pending system-auth replacement after restart', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({
        owner: 'pending',
        next: { owner: 'system-default', authJson: systemAuth },
        runtimeAuthJson: systemAuth
      })}\n`
    )

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('recovers runtime auth quarantined by an interrupted guarded update', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const heldAuthPath = `${runtimeAuthPath}.orca-guarded`
    renameSync(runtimeAuthPath, heldAuthPath)

    setShellStartupEnvProbeSupportedForTest(true)
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
    expect(existsSync(heldAuthPath)).toBe(false)
  })

  it('fences a pending auth replacement when runtime bytes do not match its intent', async () => {
    const systemAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'system')
    const retainedAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'retained')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({
        owner: 'pending',
        next: { owner: 'system-default', authJson: systemAuth },
        runtimeAuthJson: systemAuth
      })}\n`
    )
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')

    setShellStartupEnvProbeSupportedForTest(true)
    rmSync(getSystemCodexAuthPath())
    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
  })

  it('does not treat malformed provenance as a missing migration marker', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getSharedRuntimeAuthProvenancePath(), '{"owner":"pending"}\n')

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('recreates proven logged-out shared auth after a real-home re-login', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    const service = new CodexRuntimeHomeService(store as never)
    rmSync(getSystemCodexAuthPath())
    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)

    writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
  })

  it.each([
    ['committed provenance', false],
    ['pre-provenance migration', true]
  ])(
    'recreates retained auth after a %s crash between logout deletion and metadata commit',
    async (_label, removeProvenance) => {
      const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
      const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
      writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
      const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      new CodexRuntimeHomeService(store as never)

      setShellStartupEnvProbeSupportedForTest(true)
      rmSync(getSystemCodexAuthPath())
      rmSync(getRuntimeCodexAuthPath())
      if (removeProvenance) {
        rmSync(getSharedRuntimeAuthProvenancePath())
      }
      rmSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json'),
        {
          force: true
        }
      )
      const restartedService = new CodexRuntimeHomeService(store as never)
      restartedService.setRealHomeLaneGate(() => true)

      expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
      writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
      expect(restartedService.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
    }
  )

  it('recreates retained auth after interrupted logout crosses a managed transition', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed-token')
    )
    const settings = createSettings({
      shellStartupEnvProbeSupported: false,
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
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    rmSync(getSystemCodexAuthPath())
    rmSync(getRuntimeCodexAuthPath())
    rmSync(
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json'),
      {
        force: true
      }
    )
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.setRealHomeLaneGate(() => true)
    restartedService.reconcileLegacySharedHomeForRetainedPanes()

    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    restartedService.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    restartedService.syncForCurrentSelection()

    restartedService.prepareForRateLimitFetch()
    restartedService.prepareForRateLimitFetch()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
  })

  it('preserves shared config changes when a pending real-home lane falls back', async () => {
    const systemConfigPath = join(getSystemCodexHomePath(), 'config.toml')
    const runtimeConfigPath = join(getRuntimeCodexHomePath(), 'config.toml')
    writeFileSync(systemConfigPath, 'model = "baseline"\n', 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    writeFileSync(runtimeConfigPath, 'model = "runtime-change"\n', 'utf-8')

    setShellStartupEnvProbeSupportedForTest(true)
    service.setRealHomeLaneGate(() => false)
    service.reconcileLegacySharedHomeForRetainedPanes()
    expect(readFileSync(systemConfigPath, 'utf-8')).toBe('model = "baseline"\n')
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "runtime-change"\n')

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(readFileSync(systemConfigPath, 'utf-8')).toBe('model = "runtime-change"\n')
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "runtime-change"\n')
  })

  it('routes a host MANAGED account to its own self-contained home', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
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
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A host managed account's own home is its CODEX_HOME.
    expect(service.isHostSystemDefaultRealHome()).toBe(false)
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(false)
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)
    expect(
      service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())
    ).toBeNull()
    // The per-account home keeps its own auth in place; the shared mirror's
    // auth.json is never hot-swapped, so two accounts cannot race one file.
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"managed"}\n'
    )
    expect(existsSync(runtimeAuthPath)).toBe(false)
    // Session discovery includes the per-account home so its rollouts surface.
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toContain(managedHomePath)
  })

  it('gives two managed accounts distinct homes without racing one auth.json', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one')
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-2', 'two')
    const home1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const home2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: home1,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: home2,
          providerAccountId: 'acct-2',
          workspaceLabel: null,
          workspaceAccountId: 'acct-2',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A pane for account-1 launches, then the user switches and a second pane
    // for account-2 launches concurrently — each gets its OWN CODEX_HOME.
    expect(service.prepareForCodexLaunch()).toBe(home1)
    settings.activeCodexManagedAccountId = 'account-2'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-2', wsl: {} }
    expect(service.prepareForCodexLaunch()).toBe(home2)
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: home1
      })
    ).toBe(home2)
    expect(store.updateSettings).not.toHaveBeenCalled()

    // Nothing is hot-swapped, so the still-running account-1 pane keeps seeing
    // account-1's credentials — the single-auth.json race (GAP-5) is gone.
    expect(readFileSync(join(home1, 'auth.json'), 'utf-8')).toBe(account1Auth)
    expect(readFileSync(join(home2, 'auth.json'), 'utf-8')).toBe(account2Auth)
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
  })

  it('materializes resources and config into the per-account home on launch', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    mkdirSync(join(getSystemCodexHomePath(), 'skills', 'review'), { recursive: true })
    writeFileSync(
      join(getSystemCodexHomePath(), 'skills', 'review', 'SKILL.md'),
      'skill\n',
      'utf-8'
    )
    writeFileSync(
      join(getSystemCodexHomePath(), 'config.toml'),
      'approval_policy = "never"\n',
      'utf-8'
    )
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(home1)
    // Resources link/copy into THIS home; config mirrors into it.
    expectResourceLinkedOrCopied(join(home1, 'skills'), join(getSystemCodexHomePath(), 'skills'))
    expect(readFileSync(join(home1, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('skill\n')
    expect(readFileSync(join(home1, 'config.toml'), 'utf-8')).toContain('approval_policy = "never"')
    // ~/.codex is never mutated: no auth churn, no per-account dir written back.
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe('{"account":"system"}\n')
  })

  it('points the rate-limit fetch at the per-account home', async () => {
    const home1 = createManagedAuth(testState.userDataDir, 'account-1', '{"account":"managed"}\n')
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForRateLimitFetch()).toBe(home1)
  })

  it('preserves a managed selection whose auth.json is temporarily missing', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    // A managed home that has lost its auth.json (only the marker remains).
    const brokenHome = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(brokenHome, { recursive: true })
    writeFileSync(join(brokenHome, '.orca-managed-home'), 'account-1\n', 'utf-8')
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: brokenHome,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(brokenHome)
    expect(service.prepareForRateLimitFetch()).toBe(brokenHome)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
  })

  it('keeps pre-E shared-mirror sessions discoverable alongside per-account rollouts', async () => {
    // Pre-E history lives in the shared runtime mirror; after upgrading to
    // per-account homes, new rollouts land in the account's own home.
    const sharedSessionsDir = join(getRuntimeCodexHomePath(), 'sessions', '2026', '07', '16')
    mkdirSync(sharedSessionsDir, { recursive: true })
    writeFileSync(join(sharedSessionsDir, 'rollout-pre-e.jsonl'), '{"record":"pre-e"}\n', 'utf-8')
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const perAccountSessionsDir = join(home1, 'sessions', '2026', '07', '17')
    mkdirSync(perAccountSessionsDir, { recursive: true })
    writeFileSync(
      join(perAccountSessionsDir, 'rollout-e-era.jsonl'),
      '{"record":"e-era"}\n',
      'utf-8'
    )
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // Migrating to per-account homes must not strand the pre-E shared-mirror
    // history: both roots surface in discovery so no session is lost.
    const discovery = service.getHostCodexHomePathsForSessionDiscovery()
    expect(discovery).toContain(getRuntimeCodexHomePath())
    expect(discovery).toContain(home1)
  })

  it('surfaces per-account rollouts for session discovery on the mirror lane', async () => {
    // A Windows host keeps the shared system-default mirror, but its managed
    // accounts still launch from their own homes and accumulate rollouts there.
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const rolloutDir = join(home1, 'sessions', '2026', '07', '17')
    mkdirSync(rolloutDir, { recursive: true })
    writeFileSync(join(rolloutDir, 'rollout-e-era.jsonl'), '{"record":"e-era"}\n', 'utf-8')
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: false,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // The mirror lane must not hide rollouts living in the per-account home.
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toContain(home1)
  })

  it('keeps per-account auth canonical when the real-home lane takes over', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const refreshedManagedAuth = createCodexAuthJson(
      'user@example.com',
      'acct-user',
      'refreshed',
      2
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // Launching the account from its own home never populates the
    // legacy shared mirror.
    expect(service.isHostSystemDefaultRealHome()).toBe(false)
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)

    // A stale pre-E process writes matching, newer bytes to the shared mirror.
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')

    // Selection drops to the system default WITHOUT an explicit select (no
    // syncForCurrentSelection), then Codex launches on the real home.
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    expect(service.isHostSystemDefaultRealHome()).toBe(true)
    expect(service.prepareForCodexLaunch()).toBeNull()

    // E owns refreshes in place, so takeover ignores later shared-mirror bytes.
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedManagedAuth)
  })

  it('does not read shared auth when polling observes a managed-to-real-home transition', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const refreshedManagedAuth = createCodexAuthJson(
      'user@example.com',
      'acct-user',
      'refreshed',
      2
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    const syncSpy = vi.spyOn(service, 'syncForCurrentSelection')

    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(syncSpy).not.toHaveBeenCalled()

    expect(service.prepareForRateLimitFetch()).toBe(getSystemCodexHomePath())
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(syncSpy).not.toHaveBeenCalled()
  })

  it('preserves selected identity when per-account auth disappears before launch', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one', 1)
    const account1Refreshed = createCodexAuthJson('one@example.com', 'acct-1', 'one-refreshed', 2)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'wsl-account',
      createCodexAuthJson('wsl@example.com', 'acct-wsl', 'wsl')
    )
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
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
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A stale pre-E process leaves a matching refresh in the shared runtime home.
    writeFileSync(runtimeAuthPath, account1Refreshed, 'utf-8')

    // The active account's canonical auth disappears before launch.
    rmSync(join(managedHomePath1, 'auth.json'), { force: true })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath1)

    // Missing canonical auth preserves selection without reviving shared bytes.
    expect(existsSync(join(managedHomePath1, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account1Refreshed)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    expect(service.isHostSystemDefaultRealHome()).toBe(false)
    expect(service.prepareForRateLimitFetch()).toBe(managedHomePath1)
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath1)
    expect(existsSync(join(managedHomePath1, 'auth.json'))).toBe(false)

    writeFileSync(join(managedHomePath1, 'auth.json'), account1Auth, 'utf-8')
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath1
      })
    ).toBe(managedHomePath1)
    expect(store.updateSettings).not.toHaveBeenCalled()

    rmSync(join(managedHomePath1, 'auth.json'), { force: true })
    // Why: the first missing read may be a rotation in flight — the selection
    // survives the grace window and the launch still targets the account home.
    const absenceObservedAt = Date.now()
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath1
      })
    ).toBe(managedHomePath1)
    expect(store.updateSettings).not.toHaveBeenCalled()

    // Once the absence outlives the grace window it is durable and deselects.
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => absenceObservedAt + 6_000)
    try {
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: managedHomePath1
        })
      ).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual({
      host: null,
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(store.getSettings().codexManagedAccounts).toHaveLength(2)
    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-runtime-home] Active managed account credential remained unavailable, clearing selection'
    )
  })

  it('does not deselect the account when a transient unreadable auth.json heals', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const accountAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', accountAuth)
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: 'acct-user',
            workspaceLabel: null,
            workspaceAccountId: 'acct-user',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A mid-write read observes torn JSON: no deselect, and the launch still
    // targets the account home so codex re-reads the settled file itself.
    writeFileSync(join(managedHomePath, 'auth.json'), '{"tokens":{"acc', 'utf-8')
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath
      })
    ).toBe(managedHomePath)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()

    // The write completes; even past the grace window the selection is intact.
    writeFileSync(join(managedHomePath, 'auth.json'), accountAuth, 'utf-8')
    const healedAt = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => healedAt + 60_000)
    try {
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: managedHomePath
        })
      ).toBe(managedHomePath)
    } finally {
      nowSpy.mockRestore()
    }
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[codex-runtime-home] Active managed account credential remained unavailable, clearing selection'
    )
  })

  it('ignores mismatched runtime auth when the active managed auth is missing', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const mismatchedAuth = createCodexAuthJson('other@example.com', 'acct-other', 'other', 2)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, mismatchedAuth, 'utf-8')
    rmSync(join(managedHomePath, 'auth.json'), { force: true })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)

    expect(existsSync(join(managedHomePath, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(mismatchedAuth)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('ignores shared auth on an explicit managed-to-real-home deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const refreshedManagedAuth = createCodexAuthJson(
      'user@example.com',
      'acct-user',
      'refreshed',
      2
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A stale pre-E process writes matching bytes, then the normal selection
    // path deselects the self-contained account.
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)

    // A subsequent real-home launch also leaves both stores untouched.
    const syncSpy = vi.spyOn(service, 'syncForCurrentSelection')
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(syncSpy).not.toHaveBeenCalled()
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
  })

  it('mirrors later system Codex config changes before launch', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "first"\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "second"\n', 'utf-8')
    service.prepareForCodexLaunch()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
      'model = "second"\n'
    )
  })

  it('launches the system-default custom provider without requiring OAuth auth', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    const canonicalConfigPath = join(systemCodexHome, 'config.toml')
    const canonicalConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'env_key = "CODEX_LB_API_KEY"',
      ''
    ].join('\n')
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
      canonicalConfig
    )
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
    expect(readFileSync(canonicalConfigPath, 'utf-8')).toBe(canonicalConfig)
  })

  it('links system Codex user resources into the managed runtime home before launch', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    mkdirSync(join(systemCodexHome, 'skills', 'review'), { recursive: true })
    writeFileSync(join(systemCodexHome, 'skills', 'review', 'SKILL.md'), 'review skill\n', 'utf-8')
    mkdirSync(join(systemCodexHome, 'plugins'), { recursive: true })
    writeFileSync(join(systemCodexHome, 'plugins', 'plugin.json'), '{"name":"plugin"}\n', 'utf-8')
    writeFileSync(join(systemCodexHome, 'profile-v2'), 'profile\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()

    const runtimeSkillsPath = join(getRuntimeCodexHomePath(), 'skills')
    const runtimePluginsPath = join(getRuntimeCodexHomePath(), 'plugins')
    const runtimeProfilePath = join(getRuntimeCodexHomePath(), 'profile-v2')
    expectResourceLinkedOrCopied(runtimeSkillsPath, join(systemCodexHome, 'skills'))
    expectResourceLinkedOrCopied(runtimePluginsPath, join(systemCodexHome, 'plugins'))
    expectResourceLinkedOrCopied(runtimeProfilePath, join(systemCodexHome, 'profile-v2'))
    expect(readFileSync(join(runtimeSkillsPath, 'review', 'SKILL.md'), 'utf-8')).toBe(
      'review skill\n'
    )
    expect(readFileSync(runtimeProfilePath, 'utf-8')).toBe('profile\n')
  })

  it('starts the system Codex session bridge without replacing runtime sessions', async () => {
    const systemMissingRuntimeSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-old.jsonl'
    )
    const systemConflictSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-conflict.jsonl'
    )
    const runtimeConflictSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-conflict.jsonl'
    )
    mkdirSync(join(getSystemCodexHomePath(), 'sessions', '2026', '05', '26'), { recursive: true })
    mkdirSync(join(getRuntimeCodexHomePath(), 'sessions', '2026', '05', '26'), {
      recursive: true
    })
    writeFileSync(systemMissingRuntimeSessionPath, '{"id":"old"}\n', 'utf-8')
    writeFileSync(systemConflictSessionPath, '{"id":"system-conflict"}\n', 'utf-8')
    writeFileSync(runtimeConflictSessionPath, '{"id":"runtime-conflict"}\n', 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'state_5.sqlite'), 'sqlite\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { startSystemCodexSessionBridgeInBackground } =
      await import('../codex/codex-session-bridge')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()
    await startSystemCodexSessionBridgeInBackground()

    const runtimeMissingSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-old.jsonl'
    )
    expect(readFileSync(runtimeMissingSessionPath, 'utf-8')).toBe('{"id":"old"}\n')
    expectResourceLinkedOrCopied(runtimeMissingSessionPath, systemMissingRuntimeSessionPath)
    expect(readFileSync(runtimeConflictSessionPath, 'utf-8')).toBe('{"id":"runtime-conflict"}\n')
    expect(existsSync(join(getRuntimeCodexHomePath(), 'state_5.sqlite'))).toBe(false)
  })

  it('does not replace runtime-owned Codex files while linking user resources', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    mkdirSync(join(systemCodexHome, 'sessions'), { recursive: true })
    mkdirSync(join(systemCodexHome, 'skills'), { recursive: true })
    writeFileSync(join(systemCodexHome, 'auth.json'), '{"account":"system"}\n', 'utf-8')
    writeFileSync(join(systemCodexHome, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
    writeFileSync(join(systemCodexHome, 'skills', 'system.md'), 'system\n', 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'hooks.json'), '{"hooks":{"Stop":[]}}\n', 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), '{"id":"runtime"}\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'auth.json'), 'utf-8')).toBe(
      '{"account":"system"}\n'
    )
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'hooks.json'), 'utf-8')).toBe(
      '{"hooks":{"Stop":[]}}\n'
    )
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"runtime"}\n'
    )
    expect(existsSync(join(getRuntimeCodexHomePath(), 'sessions'))).toBe(false)
    expectResourceLinkedOrCopied(
      join(getRuntimeCodexHomePath(), 'skills'),
      join(systemCodexHome, 'skills')
    )
  })

  it('does not touch host auth on startup when the active account is WSL-backed', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"host-system"}\n', 'utf-8')
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"wsl"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
    })
    const store = createStore(settings)

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"host-system"}\n')
      expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(
        '{"account":"wsl"}\n'
      )
      expect(service.prepareForRateLimitFetch()).toBe(getRuntimeCodexHomePath())
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('clears a selected WSL managed account when auth.json is missing', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-token')
    )
    rmSync(join(managedHomePath, 'auth.json'), { force: true })
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemAuth, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(store.updateSettings).toHaveBeenCalledWith({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(systemAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('seeds the WSL runtime config with rewritten paths and no system hook trust', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(
      join(systemCodexHomePath, 'config.toml'),
      [
        'model_instructions_file = "instructions.md"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        '',
        '[projects."/home/alice/repo"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    const store = createStore(createSettings())

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      const runtimeConfigPath = join(wslRuntimeHomePath, 'config.toml')
      const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
      expect(runtimeConfig).toContain(
        `model_instructions_file = '${join(systemCodexHomePath, 'instructions.md')}'`
      )
      expect(runtimeConfig).toContain('[projects."/home/alice/repo"]')
      expect(runtimeConfig).not.toContain('[hooks.state.')

      // Why: WSL runtime configs are seeded once; Codex writes trust into them
      // afterwards, so a relaunch must not clobber the seeded file.
      writeFileSync(runtimeConfigPath, `${runtimeConfig}\n[projects."/tmp/x"]\n`, 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(runtimeConfigPath, 'utf-8')).toContain('[projects."/tmp/x"]')
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('anchors WSL seed rewrites to the Linux-side home parsed from the UNC source', async () => {
    const { prepareWslRuntimeSeedConfig } = await import('./runtime-home-service')

    // Why: real UNC sources cannot back live fs operations in tests, so pin
    // the UNC -> Linux-side anchor translation on the extracted seed function.
    expect(
      prepareWslRuntimeSeedConfig(
        'model_instructions_file = "instructions.md"\n',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
      )
    ).toContain("model_instructions_file = '/home/alice/.codex/instructions.md'")
    expect(
      prepareWslRuntimeSeedConfig(
        'model_instructions_file = "instructions.md"\n',
        '\\\\wsl$\\Ubuntu\\home\\alice\\.codex'
      )
    ).toContain("model_instructions_file = '/home/alice/.codex/instructions.md'")
  })

  it('switches WSL accounts by rewriting one stable WSL runtime home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const firstAuth = createCodexAuthJson('first@example.com', 'acct-first', 'first-token')
    const secondAuth = createCodexAuthJson('second@example.com', 'acct-second', 'second-token')
    const firstManagedHomePath = createManagedAuth(testState.userDataDir, 'account-1', firstAuth)
    const secondManagedHomePath = createManagedAuth(testState.userDataDir, 'account-2', secondAuth)
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'first@example.com',
            managedHomePath: firstManagedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
            providerAccountId: 'acct-first',
            workspaceLabel: null,
            workspaceAccountId: 'acct-first',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'account-2',
            email: 'second@example.com',
            managedHomePath: secondManagedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-2/home',
            providerAccountId: 'acct-second',
            workspaceLabel: null,
            workspaceAccountId: 'acct-second',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(firstAuth)

      store.updateSettings({
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-2' } }
      })
      service.syncForCurrentSelection(target)

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(secondAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not use host auth baseline to accept stale WSL runtime auth', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const hostAuth = createCodexAuthJson('host@example.com', 'acct-host', 'host-token')
    const wslManagedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'managed-newer',
      2_000
    )
    const staleWslRuntimeAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-stale',
      1_000
    )
    const hostManagedHomePath = createManagedAuth(testState.userDataDir, 'host-account', hostAuth)
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'wsl-account',
      wslManagedAuth
    )
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    mkdirSync(wslRuntimeHomePath, { recursive: true })
    writeFileSync(join(wslRuntimeHomePath, 'auth.json'), staleWslRuntimeAuth, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'host-account',
            email: 'host@example.com',
            managedHomePath: hostManagedHomePath,
            providerAccountId: 'acct-host',
            workspaceLabel: null,
            workspaceAccountId: 'acct-host',
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
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountId: 'host-account',
        activeCodexManagedAccountIdsByRuntime: {
          host: 'host-account',
          wsl: { Ubuntu: 'wsl-account' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(readFileSync(join(wslManagedHomePath, 'auth.json'), 'utf-8')).toBe(wslManagedAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(wslManagedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not clobber fresh WSL tokens after clearLastWrittenAuthJson', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const originalAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'original', 1_000)
    const staleRuntimeAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'stale', 1_500)
    const reauthedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'reauthed', 2_000)
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    const runtimeAuthPath = join(wslRuntimeHomePath, 'auth.json')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'account-1' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      writeFileSync(runtimeAuthPath, staleRuntimeAuth, 'utf-8')
      writeFileSync(managedAuthPath, reauthedAuth, 'utf-8')

      service.clearLastWrittenAuthJson('account-1')
      service.syncForCurrentSelection(target)

      expect(readFileSync(managedAuthPath, 'utf-8')).toBe(reauthedAuth)
      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(reauthedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('reads active WSL token refreshes back before restart using the selected distro', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const managedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed', 1_000)
    const refreshedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-refreshed',
      2_000
    )
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: null,
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'account-1' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )
      const runtimeAuthPath = join(wslRuntimeHomePath, 'auth.json')

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')

      service.syncActiveWslSelectionsBeforeRestart()

      expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('reads WSL system-default rate limits from the live system home without materializing', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const syncWslRuntime = vi.spyOn(
        service as unknown as {
          syncWslRuntimeForCurrentSelection: (target: {
            runtime: 'wsl'
            wslDistro?: string | null
          }) => string | null
        },
        'syncWslRuntimeForCurrentSelection'
      )
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      const expectedHome = join(wslHome, '.codex')

      expect(service.prepareForRateLimitFetch(target)).toBe(expectedHome)
      expect(service.prepareForRateLimitFetch(target)).toBe(expectedHome)
      expect(syncWslRuntime).not.toHaveBeenCalled()
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('uses the default distro selection for WSL-default rate-limit fetches', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const ubuntuAuth = createCodexAuthJson('ubuntu@example.com', 'acct-ubuntu', 'ubuntu-token')
    const debianAuth = createCodexAuthJson('debian@example.com', 'acct-debian', 'debian-token')
    const ubuntuHomePath = createManagedAuth(testState.userDataDir, 'ubuntu-account', ubuntuAuth)
    const debianHomePath = createManagedAuth(testState.userDataDir, 'debian-account', debianAuth)
    const runtimeAuthPath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home',
      'auth.json'
    )
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'ubuntu-account',
            email: 'ubuntu@example.com',
            managedHomePath: ubuntuHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/ubuntu/home',
            providerAccountId: 'acct-ubuntu',
            workspaceLabel: null,
            workspaceAccountId: 'acct-ubuntu',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'debian-account',
            email: 'debian@example.com',
            managedHomePath: debianHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Debian',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/debian/home',
            providerAccountId: 'acct-debian',
            workspaceLabel: null,
            workspaceAccountId: 'acct-debian',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'ubuntu-account', Debian: 'debian-account' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: null })).toBe(
        join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
      )
      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(ubuntuAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not write WSL system-default auth into managed accounts', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const managedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-old', 1_000)
    const systemDefaultAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'system-newer',
      2_000
    )
    const managedHomePath = createManagedAuth(testState.userDataDir, 'wsl-account', managedAuth)
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemDefaultAuth, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'wsl-account',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/wsl-account/home',
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        systemCodexHomePath
      )
      expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
      const externallyRefreshedAuth = createCodexAuthJson(
        'wsl@example.com',
        'acct-wsl',
        'system-refreshed',
        3_000
      )
      writeFileSync(join(systemCodexHomePath, 'auth.json'), externallyRefreshedAuth, 'utf-8')
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        systemCodexHomePath
      )
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(
        externallyRefreshedAuth
      )
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('reads WSL system-default token refreshes back to WSL system auth', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'system-old', 1_000)
    const refreshedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-refreshed',
      2_000
    )
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemAuth, 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      writeFileSync(join(wslRuntimeHomePath, 'auth.json'), refreshedAuth, 'utf-8')

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(refreshedAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(refreshedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('preserves WSL system-default token refreshes after app restart', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'system-old', 1_000)
    const refreshedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-refreshed',
      2_000
    )
    const systemCodexHomePath = join(wslHome, '.codex')
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    mkdirSync(systemCodexHomePath, { recursive: true })
    mkdirSync(wslRuntimeHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemAuth, 'utf-8')
    writeFileSync(join(wslRuntimeHomePath, 'auth.json'), refreshedAuth, 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(refreshedAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(refreshedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not overwrite auth.json when no managed account was ever active', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"original"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, '{"account":"external-switch"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-switch"}\n')
  })

  it('refreshes the runtime auth when the system-default auth changes later', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-1"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-1"}\n')

    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-2"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-2"}\n')
  })

  it('reads back system-default token refreshes from runtime auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-old')
    const refreshedAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-refreshed'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(
      JSON.parse(
        readFileSync(
          join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
          'utf-8'
        )
      )
    ).toEqual({ authJson: refreshedAuth })
  })

  it('reads back system-default token refreshes after a pre-provenance restart', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-old',
      undefined,
      '2026-07-30T12:00:00.000Z'
    )
    const refreshedAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-refreshed',
      undefined,
      '2026-07-31T12:00:00.000Z'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('does not read back older same-identity auth without provenance', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-newer',
      undefined,
      '2026-07-31T12:00:00.000Z'
    )
    const staleRuntimeAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'runtime-older',
      undefined,
      '2026-07-30T12:00:00.000Z'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, staleRuntimeAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
  })

  it('keeps a local runtime logout when the system-default auth still exists', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('keeps a local runtime logout after restart when the system-default auth still exists', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    new CodexRuntimeHomeService(store as never)

    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(true)
  })

  it('mirrors a fresh external system-default login after a persisted local runtime logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-new"}\n', 'utf-8')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-new"}\n')
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(false)
  })

  it('mirrors a fresh external system-default login after a same-process local runtime logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-new"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-new"}\n')
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(false)
  })

  it('clears the mirrored runtime auth after an external system-default logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath(), { force: true })
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('clears mirrored runtime auth after restart when the system-default auth was deleted', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath(), { force: true })
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('clears refreshed runtime auth after an external system-default logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const refreshedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'refreshed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    rmSync(getSystemCodexAuthPath(), { force: true })
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(true)
  })

  it('clears refreshed runtime auth after a pre-provenance external logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system',
      undefined,
      '2026-07-30T12:00:00.000Z'
    )
    const refreshedAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed',
      undefined,
      '2026-07-31T12:00:00.000Z'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    rmSync(getSystemCodexAuthPath())
    new CodexRuntimeHomeService(store as never)

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('persists runtime auth refreshes after returning to system default', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const refreshedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'refreshed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
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

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    // Deselect managed account — should restore system default once
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)

    // Codex used to refresh tokens directly in ~/.codex. With an Orca-owned
    // runtime home, the same refresh must be read back to the system default.
    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
  })

  it('does not write stale managed runtime auth back to system default', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    const staleManagedRefresh = createCodexAuthJson(
      'managed@example.com',
      'acct-managed',
      'managed-refreshed'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
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
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    writeFileSync(runtimeAuthPath, staleManagedRefresh, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
  })

  it('imports legacy managed-home history into the shared runtime history', async () => {
    const runtimeHomePath = getRuntimeCodexHomePath()
    const runtimeHistoryPath = join(runtimeHomePath, 'history.jsonl')
    writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    writeFileSync(
      join(managedHomePath, 'history.jsonl'),
      '{"id":"shared-1"}\n{"id":"managed-2"}\n',
      'utf-8'
    )
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe(
      '{"id":"shared-1"}\n{"id":"managed-2"}\n'
    )
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'migration-v1.json'))).toBe(
      true
    )
  })

  it('writes auth.json with restrictive permissions', async () => {
    if (process.platform === 'win32') {
      return
    }

    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    const mode = statSync(runtimeAuthPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('tightens auth.json permissions when unchanged content is already present', async () => {
    if (process.platform === 'win32') {
      return
    }

    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    chmodSync(runtimeAuthPath, 0o644)
    service.syncForCurrentSelection()

    expect(statSync(runtimeAuthPath).mode & 0o777).toBe(0o600)
  })

  it('does not throw when syncForCurrentSelection encounters an error', async () => {
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath: '/nonexistent/path/home',
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
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    expect(() => new CodexRuntimeHomeService(store as never)).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('does not re-run migration when marker already exists', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    writeFileSync(join(managedHomePath, 'history.jsonl'), '{"id":"legacy-1"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toContain('legacy-1')

    writeFileSync(
      join(managedHomePath, 'history.jsonl'),
      '{"id":"legacy-1"}\n{"id":"legacy-2"}\n',
      'utf-8'
    )

    vi.resetModules()
    const mod2 = await import('./runtime-home-service')
    new mod2.CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).not.toContain('legacy-2')
  })

  it('clears system-default snapshot via clearSystemDefaultSnapshot', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    const snapshotPath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'system-default-auth.json'
    )
    expect(existsSync(snapshotPath)).toBe(true)

    service.clearSystemDefaultSnapshot()
    expect(existsSync(snapshotPath)).toBe(false)
  })

  it('reads back verified same-account refreshes on first sync after restart', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const originalAuth = createCodexAuthJson('user@example.com', 'acct-1', 'original', 1_000)
    const refreshedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'refreshed', 2_000)
    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1'
      })
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('restores system default when unverified runtime auth appears before deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
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

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    // A stale or external process overwrites runtime with auth Orca cannot
    // verify against the outgoing managed account.
    writeFileSync(runtimeAuthPath, '{"account":"external-login"}\n', 'utf-8')

    // Deselect managed account
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(true)
  })

  it('restores system default when stale Codex credentials are rejected on deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const selectedAuth = createCodexAuthJson('selected@example.com', 'acct-selected', 'selected')
    const staleLivePtyAuth = createCodexAuthJson('stale@example.com', 'acct-stale', 'stale')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', selectedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'selected@example.com',
          managedHomePath,
          providerAccountId: 'acct-selected',
          workspaceLabel: null,
          workspaceAccountId: 'acct-selected',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    writeFileSync(runtimeAuthPath, staleLivePtyAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(selectedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-old"}\n')
  })

  it('keeps external Codex logout when deselecting managed account', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system-old"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
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

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('recreates retained auth after a logged-out system default logs back in', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath())
    service.syncForCurrentSelection()
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)

    setShellStartupEnvProbeSupportedForTest(true)
    service.setRealHomeLaneGate(() => true)
    writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
    service.reconcileLegacySharedHomeForRetainedPanes()

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
  })

  it('captures a fresh system-default snapshot when re-entering managed mode', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-1"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
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

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-2"}\n', 'utf-8')

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-2"}\n')
  })

  it('preserves conflicting legacy session files under deterministic names', async () => {
    const runtimeSessionsDir = join(getRuntimeCodexHomePath(), 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'session.json'), '{"turns":[1]}', 'utf-8')
    mkdirSync(join(runtimeSessionsDir, 'nested'), { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'nested', 'session.json'), '{"turns":[2]}', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const legacySessionsDir = join(managedHomePath, 'sessions')
    mkdirSync(legacySessionsDir, { recursive: true })
    writeFileSync(join(legacySessionsDir, 'session.json'), '{"turns":[1,2]}', 'utf-8')
    mkdirSync(join(legacySessionsDir, 'nested'), { recursive: true })
    writeFileSync(join(legacySessionsDir, 'nested', 'session.json'), '{"turns":[2,3]}', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(runtimeSessionsDir, 'session.json'), 'utf-8')).toBe('{"turns":[1]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
    expect(
      readFileSync(
        join(runtimeSessionsDir, 'nested', 'session.orca-legacy-account-1.json'),
        'utf-8'
      )
    ).toBe('{"turns":[2,3]}')
    const diagnostics = readFileSync(
      join(testState.userDataDir, 'codex-runtime-home', 'migration-diagnostics.jsonl'),
      'utf-8'
    )
      .trim()
      .split('\n')
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toContain('"type":"session-conflict"')
  })
})
