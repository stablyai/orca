/* eslint-disable max-lines -- test suite covers snapshot, migration, auth materialization, and error-resilience scenarios */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/types'

const testState = { userDataDir: '', fakeHomeDir: '' }

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
  return {
    workspaceDir: testState.fakeHomeDir,
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'git-username',
    branchPrefixCustom: '',
    theme: 'system',
    editorAutoSave: false,
    editorAutoSaveDelayMs: 1000,
    editorMinimapEnabled: false,
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
    openLinksInApp: false,
    rightSidebarOpenByDefault: true,
    showTitlebarAppName: true,
    showTasksButton: true,
    floatingTerminalEnabled: false,
    floatingTerminalCwd: '~',
    floatingTerminalTriggerLocation: 'floating-button',
    diffDefaultView: 'inline',
    notifications: {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      suppressWhenFocused: true,
      customSoundPath: null
    },
    promptCacheTimerEnabled: false,
    promptCacheTtlMs: 300_000,
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    terminalScopeHistoryByWorktree: true,
    defaultTuiAgent: null,
    skipDeleteWorktreeConfirm: false,
    skipDeleteAutomationConfirm: false,
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    keepComputerAwakeWhileAgentsRun: false,
    terminalMacOptionAsAlt: 'false',
    terminalMacOptionAsAltMigrated: true,
    experimentalMobile: false,
    mobileAutoRestoreFitMs: null,
    experimentalPet: false,
    experimentalActivity: true,
    experimentalWorktreeSymlinks: false,
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'powershell.exe',
    enableGitHubAttribution: true,
    ...overrides,
    appFontFamily
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
    mkdirSync(join(testState.fakeHomeDir, '.codex'), { recursive: true })
  })

  afterEach(() => {
    rmSync(testState.userDataDir, { recursive: true, force: true })
    rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  })

  it('captures the existing ~/.codex auth as the system-default snapshot', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
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

  it('materializes the active managed account auth into ~/.codex on startup', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"managed"}\n')
    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(false)
  })

  it('restores the system-default snapshot when no managed account is selected', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

  it('removes runtime auth when deselecting with a corrupt system-default snapshot', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

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

    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(existsSync(snapshotPath)).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-runtime-home] Ignoring invalid system-default auth snapshot'
    )
  })

  it('clears an invalid active account selection and removes untrusted runtime auth', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

    expect(store.updateSettings).toHaveBeenCalledWith({ activeCodexManagedAccountId: null })
    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('clears an unknown active account id and removes untrusted runtime auth', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"stale-managed"}\n', 'utf-8')
    const settings = createSettings({
      activeCodexManagedAccountId: 'missing-account'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(store.updateSettings).toHaveBeenCalledWith({ activeCodexManagedAccountId: null })
    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('returns ~/.codex for Codex launch and rate-limit preparation', async () => {
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(join(testState.fakeHomeDir, '.codex'))
    expect(service.prepareForRateLimitFetch()).toBe(join(testState.fakeHomeDir, '.codex'))
    expect(existsSync(join(testState.fakeHomeDir, '.codex'))).toBe(true)
  })

  it('does not overwrite auth.json when no managed account was ever active', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"original"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, '{"account":"external-switch"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-switch"}\n')
  })

  it('does not overwrite auth.json after deselection + external change', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')

    // External tool changes auth — subsequent syncs must not overwrite
    writeFileSync(runtimeAuthPath, '{"account":"external-tool"}\n', 'utf-8')
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-tool"}\n')
  })

  it('removes untrusted runtime auth on restart when persisted active account is invalid', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

    expect(store.updateSettings).toHaveBeenCalledWith({ activeCodexManagedAccountId: null })
    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('imports legacy managed-home history into the shared runtime history', async () => {
    const runtimeHomePath = join(testState.fakeHomeDir, '.codex')
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

    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

    const runtimeHistoryPath = join(testState.fakeHomeDir, '.codex', 'history.jsonl')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

    // Simulate CLI refreshing the token in ~/.codex/auth.json
    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')

    // Next sync should read back the refreshed token to managed storage
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('rejects runtime read-back from a different Codex identity', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    // the selected account in ~/.codex.
    writeFileSync(runtimeAuthPath, account1RefreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath1, 'utf-8')).toBe(account1RefreshedAuth)
    expect(readFileSync(managedAuthPath2, 'utf-8')).toBe(account2Auth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account2Auth)
  })

  it('rejects ambiguous Codex read-back instead of choosing a managed account', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"system-old"}\n', 'utf-8')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"system-old"}\n', 'utf-8')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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

  it('captures a fresh system-default snapshot when re-entering managed mode', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"system-1"}\n', 'utf-8')
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
    writeFileSync(runtimeAuthPath, '{"account":"system-2"}\n', 'utf-8')

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-2"}\n')
  })

  it('reads back refreshed tokens for the outgoing Codex account before switching', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
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
    const runtimeSessionsDir = join(testState.fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'session.json'), '{"turns":[1]}', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const legacySessionsDir = join(managedHomePath, 'sessions')
    mkdirSync(legacySessionsDir, { recursive: true })
    writeFileSync(join(legacySessionsDir, 'session.json'), '{"turns":[1,2]}', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(runtimeSessionsDir, 'session.json'), 'utf-8')).toBe('{"turns":[1]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
    expect(
      readFileSync(
        join(testState.userDataDir, 'codex-runtime-home', 'migration-diagnostics.jsonl'),
        'utf-8'
      )
    ).toContain('"type":"session-conflict"')
  })
})
