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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    skipDeleteAutomationConfirm: false,
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

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function createCodexAuthJson(
  email: string,
  accountId: string,
  refreshToken: string,
  expiresAt?: number
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
    tokens: {
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
    testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-runtime-home-'))
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
    testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = testState.userDataDir
    mkdirSync(getSystemCodexHomePath(), { recursive: true })
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
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

  it('materializes the active managed account auth into the runtime home on startup', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const store = createStore(
      createSettings({
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
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"managed"}\n')
    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(false)
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
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const store = createStore(
      createSettings({
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
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(normalizeLinkTarget(readlinkSync(legacyActiveHomePath))).toBe(
      normalizeLinkTarget(getRuntimeCodexHomePath())
    )
    expect(readFileSync(join(legacyActiveHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"managed"}\n'
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

  it('removes runtime auth when restoring a no-login system default', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
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

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"managed"}\n')

    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
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

  it('clears an invalid active account selection and removes untrusted runtime auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
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
    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('clears an invalid active account selection and restores live system default auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = '{"account":"system"}\n'
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    rmSync(runtimeAuthPath, { force: true })
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
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
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
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(service.prepareForRateLimitFetch()).toBe(getRuntimeCodexHomePath())
    expect(existsSync(getRuntimeCodexHomePath())).toBe(true)
  })

  it('uses the same host CODEX_HOME after switching managed Codex accounts', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one')
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-2', 'two')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
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
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: managedHomePath2,
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

    const account1Home = service.prepareForCodexLaunch()
    settings.activeCodexManagedAccountId = 'account-2'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-2', wsl: {} }
    const account2Home = service.prepareForCodexLaunch()

    expect(account1Home).toBe(getRuntimeCodexHomePath())
    expect(account2Home).toBe(getRuntimeCodexHomePath())
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2Auth)
  })

  it('new host Codex launches get the selected account after preserving outgoing refreshes', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one', 1)
    const account1RefreshedAuth = createCodexAuthJson(
      'one@example.com',
      'acct-1',
      'one-refreshed',
      2
    )
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-2', 'two', 1)
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
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
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: managedHomePath2,
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

    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = 'account-2'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-2', wsl: {} }

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(readFileSync(join(managedHomePath1, 'auth.json'), 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2Auth)
  })

  it('reads back selected-account refreshes without ambiguity from duplicate identities', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const account1Auth = createCodexAuthJson('same@example.com', 'acct-same', 'one', 1)
    const account1RefreshedAuth = createCodexAuthJson(
      'same@example.com',
      'acct-same',
      'one-refreshed',
      2
    )
    const account2Auth = createCodexAuthJson('same@example.com', 'acct-same', 'two', 1)
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'same@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'same@example.com',
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
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

    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(join(managedHomePath1, 'auth.json'), 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(join(managedHomePath2, 'auth.json'), 'utf-8')).toBe(account2Auth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account1RefreshedAuth)
  })

  it('keeps fresher selected-account startup refreshes when duplicate identities exist', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const account1Auth = createCodexAuthJson('same@example.com', 'acct-same', 'one', 1)
    const account1RefreshedAuth = createCodexAuthJson(
      'same@example.com',
      'acct-same',
      'one-refreshed',
      2
    )
    const account2Auth = createCodexAuthJson('same@example.com', 'acct-same', 'two', 1)
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'same@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'same@example.com',
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(managedHomePath1, 'auth.json'), 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(join(managedHomePath2, 'auth.json'), 'utf-8')).toBe(account2Auth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account1RefreshedAuth)
  })

  it('routes stale live-pane startup refreshes to the matching account before restoring selected auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one', 1)
    const account1RefreshedAuth = createCodexAuthJson(
      'one@example.com',
      'acct-1',
      'one-refreshed',
      2
    )
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-2', 'two', 1)
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
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
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-2',
          workspaceLabel: null,
          workspaceAccountId: 'acct-2',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-2',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-2', wsl: {} }
    })
    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(managedHomePath1, 'auth.json'), 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(join(managedHomePath2, 'auth.json'), 'utf-8')).toBe(account2Auth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2Auth)
  })

  it('preserves duplicate-identity outgoing refreshes before switching to another account', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const account1Auth = createCodexAuthJson('same@example.com', 'acct-same', 'one', 1)
    const account1RefreshedAuth = createCodexAuthJson(
      'same@example.com',
      'acct-same',
      'one-refreshed',
      2
    )
    const account2Auth = createCodexAuthJson('same@example.com', 'acct-same', 'two', 1)
    const account3Auth = createCodexAuthJson('three@example.com', 'acct-3', 'three', 1)
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const managedHomePath3 = createManagedAuth(testState.userDataDir, 'account-3', account3Auth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'same@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'same@example.com',
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        },
        {
          id: 'account-3',
          email: 'three@example.com',
          managedHomePath: managedHomePath3,
          providerAccountId: 'acct-3',
          workspaceLabel: null,
          workspaceAccountId: 'acct-3',
          createdAt: 3,
          updatedAt: 3,
          lastAuthenticatedAt: 3
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = 'account-3'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-3', wsl: {} }
    service.syncForCurrentSelection()

    expect(readFileSync(join(managedHomePath1, 'auth.json'), 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(join(managedHomePath2, 'auth.json'), 'utf-8')).toBe(account2Auth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account3Auth)
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

  it('bridges system Codex sessions before launch without replacing runtime sessions', async () => {
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
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()

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

      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(hostAuth)
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

  it('uses the stable WSL runtime home for WSL system-default rate-limit fetches', async () => {
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

      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
      )
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
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(systemDefaultAuth)
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

  it('reads back system-default token refreshes after restart when the snapshot proves the baseline', async () => {
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
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
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

  it('removes untrusted runtime auth on restart when persisted active account is invalid', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: join(testState.userDataDir, 'codex-accounts', 'account-1', 'home'),
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
    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
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
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const store = createStore(
      createSettings({
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
    )

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
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
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

  it('reads back CLI-refreshed tokens into managed storage on subsequent sync', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const originalAuth = createCodexAuthJson('user@example.com', 'acct-1', 'original')
    const refreshedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'refreshed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
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

    // Simulate CLI refreshing the token in runtime CODEX_HOME/auth.json.
    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')

    // Next sync should read back the refreshed token to managed storage
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('rejects runtime read-back from a different Codex identity', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
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
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // Simulate an old live Codex PTY from another account refreshing the
    // shared runtime auth after Orca has already selected account-1.
    writeFileSync(runtimeAuthPath, staleLivePtyAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(selectedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(selectedAuth)
  })

  it('routes runtime read-back from a different Codex identity to its matching account', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-one', 'one')
    const account1RefreshedAuth = createCodexAuthJson(
      'one@example.com',
      'acct-one',
      'one-refreshed'
    )
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-two', 'two')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const managedAuthPath1 = join(managedHomePath1, 'auth.json')
    const managedAuthPath2 = join(managedHomePath2, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: managedHomePath1,
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
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-two',
          workspaceLabel: null,
          workspaceAccountId: 'acct-two',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // An older account-1 Codex process refreshed the shared runtime file after
    // Orca selected account-2. Persist the refresh to account-1, then restore
    // the selected account in runtime CODEX_HOME.
    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath1, 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(managedAuthPath2, 'utf-8')).toBe(account2Auth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2Auth)
  })

  it('rejects ambiguous Codex read-back instead of choosing a managed account', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const originalAuth = createCodexAuthJson('same@example.com', 'acct-same', 'original')
    const refreshedAuth = createCodexAuthJson('same@example.com', 'acct-same', 'refreshed')
    const activeAuth = createCodexAuthJson('active@example.com', 'acct-active', 'active')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', originalAuth)
    const managedHomePath3 = createManagedAuth(testState.userDataDir, 'account-3', activeAuth)
    const managedAuthPath1 = join(managedHomePath1, 'auth.json')
    const managedAuthPath2 = join(managedHomePath2, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'same@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'same@example.com',
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-same',
          workspaceLabel: null,
          workspaceAccountId: 'acct-same',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        },
        {
          id: 'account-3',
          email: 'active@example.com',
          managedHomePath: managedHomePath3,
          providerAccountId: 'acct-active',
          workspaceLabel: null,
          workspaceAccountId: 'acct-active',
          createdAt: 3,
          updatedAt: 3,
          lastAuthenticatedAt: 3
        }
      ],
      activeCodexManagedAccountId: 'account-3'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath1, 'utf-8')).toBe(originalAuth)
    expect(readFileSync(managedAuthPath2, 'utf-8')).toBe(originalAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(activeAuth)
  })

  it('rejects runtime read-back without a positive selected-account identity match', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const selectedAuth = createCodexAuthJson('selected@example.com', 'acct-selected', 'selected')
    const accountOnlyAuth = `${JSON.stringify({
      tokens: {
        account_id: 'acct-stale',
        refresh_token: 'stale'
      }
    })}\n`
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', selectedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'selected@example.com',
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

    writeFileSync(runtimeAuthPath, accountOnlyAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(selectedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(selectedAuth)
  })

  it('rejects same-email runtime read-back when account ids differ from sparse managed metadata', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const selectedAuth = createCodexAuthJson('user@example.com', 'acct-selected', 'selected')
    const staleLivePtyAuth = createCodexAuthJson('user@example.com', 'acct-stale', 'stale')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', selectedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
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

    writeFileSync(runtimeAuthPath, staleLivePtyAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(selectedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(selectedAuth)
  })

  it('reads back same-account refreshes for sparse managed metadata using stored auth identity', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const originalAuth = createCodexAuthJson('user@example.com', 'acct-selected', 'original')
    const refreshedAuth = createCodexAuthJson('user@example.com', 'acct-selected', 'refreshed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
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

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('reads back strong account-id refreshes when the runtime auth has no email', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const originalAuth = createCodexAuthJson('user@example.com', 'acct-1', 'original')
    const refreshedAuth = `${JSON.stringify({
      tokens: {
        account_id: 'acct-1',
        refresh_token: 'refreshed'
      }
    })}\n`
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
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

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('rejects unverifiable Codex read-back on first sync after restart', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"tokens":"refreshed-while-down"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"tokens":"original"}\n'
    )
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const store = createStore(
      createSettings({
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
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe('{"tokens":"original"}\n')
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"tokens":"original"}\n')
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

  it('rejects older same-account Codex auth on first sync after restart', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const staleRuntimeAuth = createCodexAuthJson('user@example.com', 'acct-1', 'stale', 1_000)
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'managed-newer', 2_000)
    writeFileSync(runtimeAuthPath, staleRuntimeAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
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

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(managedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(managedAuth)
  })

  it('does not contaminate the incoming Codex account during account switch', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const managedHomePath1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"tokens":"account1"}\n'
    )
    const managedHomePath2 = createManagedAuth(
      testState.userDataDir,
      'account-2',
      '{"tokens":"account2"}\n'
    )
    const managedAuthPath2 = join(managedHomePath2, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user1@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'user2@example.com',
          managedHomePath: managedHomePath2,
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

    settings.activeCodexManagedAccountId = 'account-2'
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath2, 'utf-8')).toBe('{"tokens":"account2"}\n')
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"tokens":"account2"}\n')
  })

  it('does not carry the reauth read-back skip across Codex account switches', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-one', 'one')
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-two', 'two')
    const account2RefreshedAuth = createCodexAuthJson(
      'two@example.com',
      'acct-two',
      'two-refreshed'
    )
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const managedAuthPath2 = join(managedHomePath2, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: managedHomePath1,
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
          managedHomePath: managedHomePath2,
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

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.clearLastWrittenAuthJson()
    settings.activeCodexManagedAccountId = 'account-2'
    service.syncForCurrentSelection()

    writeFileSync(runtimeAuthPath, account2RefreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath2, 'utf-8')).toBe(account2RefreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2RefreshedAuth)
  })

  it('does not apply inactive-account Codex reauth skip to the active account', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-one', 'one')
    const account1RefreshedAuth = createCodexAuthJson(
      'one@example.com',
      'acct-one',
      'one-refreshed'
    )
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-two', 'two')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const managedAuthPath1 = join(managedHomePath1, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: managedHomePath1,
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
          managedHomePath: managedHomePath2,
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

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    service.clearLastWrittenAuthJson('account-2')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath1, 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account1RefreshedAuth)
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

  it('restores system default after same-identity managed Codex refresh on deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'managed')
    const externalAuth = createCodexAuthJson('user@example.com', 'acct-1', 'external')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
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
      ]
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    writeFileSync(runtimeAuthPath, externalAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(externalAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-old"}\n')
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

  it('keeps external system-default logout when managed runtime auth still exists', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
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

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"managed"}\n')
    rmSync(getSystemCodexAuthPath(), { force: true })
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
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

  it('reads back refreshed tokens for the outgoing Codex account before switching', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const account1Original = createCodexAuthJson('one@example.com', 'acct-1', 'one-original')
    const account1Refreshed = createCodexAuthJson('one@example.com', 'acct-1', 'one-refreshed')
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-2', 'two')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Original)
    const managedHomePath2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const managedAuthPath1 = join(managedHomePath1, 'auth.json')
    const settings = createSettings({
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
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: managedHomePath2,
          providerAccountId: 'acct-2',
          workspaceLabel: null,
          workspaceAccountId: 'acct-2',
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

    writeFileSync(runtimeAuthPath, account1Refreshed, 'utf-8')
    settings.activeCodexManagedAccountId = 'account-2'
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath1, 'utf-8')).toBe(account1Refreshed)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2Auth)
  })

  it('does not clobber fresh tokens after clearLastWrittenAuthJson', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const originalAuth = createCodexAuthJson('user@example.com', 'acct-1', 'original')
    const reauthedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'reauthed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
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

    // Simulate re-auth: managed storage gets fresh tokens
    writeFileSync(managedAuthPath, reauthedAuth, 'utf-8')

    // Clear tracking before sync (as CodexAccountService would)
    service.clearLastWrittenAuthJson()
    service.syncForCurrentSelection()

    // Fresh re-auth tokens should survive — not be clobbered by stale runtime read-back
    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(reauthedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(reauthedAuth)
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
