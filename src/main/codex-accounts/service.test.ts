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
import type { GlobalSettings } from '../../shared/types'

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

function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
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
    terminalFontWeight: 500,
    terminalLineHeight: 1,
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
    terminalAllowOsc52Clipboard: false,
    setupScriptLaunchMode: 'split-vertical',
    terminalScrollbackBytes: 10_000_000,
    localAccountRuntime: 'host',
    localAccountWslDistro: null,
    openLinksInApp: false,
    openLinksInAppPreferencePrompted: false,
    rightSidebarOpenByDefault: true,
    sourceControlViewMode: 'list',
    showTitlebarAppName: true,
    showTasksButton: true,
    floatingTerminalEnabled: false,
    floatingTerminalCwd: '~',
    floatingTerminalTriggerLocation: 'floating-button',
    diffDefaultView: 'inline',
    combinedDiffFileTreeVisibleByDefault: false,
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
    experimentalWorktreeSymlinks: false,
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'powershell.exe',
    enableGitHubAttribution: true,
    ...overrides,
    localWindowsRuntimeDefault: overrides.localWindowsRuntimeDefault ?? { kind: 'windows-host' },
    leftSidebarAppearanceMode: overrides.leftSidebarAppearanceMode ?? 'default',
    appFontFamily,
    agentStatusHooksEnabled,
    tabAutoGenerateTitle
  }
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

function createRateLimits() {
  return {
    refreshForCodexAccountChange: vi.fn().mockResolvedValue(undefined),
    evictInactiveCodexCache: vi.fn()
  }
}

function createRuntimeHome() {
  return {
    syncForCurrentSelection: vi.fn(),
    clearLastWrittenAuthJson: vi.fn()
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

  it('does not rewrite managed configs that already match canonical config', async () => {
    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
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
    const canonicalConfig = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
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
    writeFileSync(wslConfigPath, 'sandbox_mode = "danger-full-access"\n', 'utf-8')

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      expect(args.slice(0, 2)).toEqual(['-d', 'Debian'])
      if (script.includes('WSL_DISTRO_NAME')) {
        return 'Debian\n/home/alice\n'
      }
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      mkdirSync(wslManagedHomePath, { recursive: true })
      writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-id-for-test\n')
      return ''
    })
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual([
        '-d',
        'Debian',
        '--exec',
        'bash',
        '-ic',
        `export CODEX_HOME='${wslLinuxHomePath}'; exec codex login`
      ])
      expect(readFileSync(join(wslManagedHomePath, 'config.toml'), 'utf-8')).toBe(
        'sandbox_mode = "danger-full-access"\n'
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
      if (script.includes('command -v codex')) {
        expect(args.slice(0, 5)).toEqual(['-d', 'Debian', '--exec', 'bash', '-ic'])
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
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual([
        '-d',
        'Ubuntu',
        '--exec',
        'bash',
        '-ic',
        `export CODEX_HOME='${wslLinuxHomePath}'; exec codex login`
      ])
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

      const result = await service.reauthenticateAccount('account-1')

      expect(result.accounts[0]).toMatchObject({
        email: 'new@example.com',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
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
      expect(args).toEqual([
        '-d',
        'Ubuntu',
        '--exec',
        'bash',
        '-ic',
        `export CODEX_HOME='${wslLinuxHomePath}'; exec codex login`
      ])
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

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.selectAccount(null)

    expect(result.activeAccountId).toBe(null)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalled()
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
})
