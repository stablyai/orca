/* eslint-disable max-lines -- test suite covers snapshot, migration, auth materialization, and error-resilience scenarios */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
    showTitlebarAgentActivity: true,
    showTasksButton: true,
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
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    terminalMacOptionAsAlt: 'false',
    terminalMacOptionAsAltMigrated: true,
    experimentalAgentDashboard: false,
    experimentalMobile: false,
    experimentalSidekick: false,
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
      readFileSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
        'utf-8'
      )
    ).toBe('{"account":"system"}\n')
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
      readFileSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
        'utf-8'
      )
    ).toBe('{"account":"system"}\n')
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
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = null
    writeFileSync(runtimeAuthPath, '{"account":"managed"}\n', 'utf-8')

    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
  })

  it('clears an invalid active account selection and restores the system default snapshot', async () => {
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
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
    expect(warnSpy).toHaveBeenCalled()
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
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // Deselect managed account — should restore system default once
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')

    // External tool changes auth — subsequent syncs must not overwrite
    writeFileSync(runtimeAuthPath, '{"account":"external-tool"}\n', 'utf-8')
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-tool"}\n')
  })

  it('restores system default on restart when persisted active account is invalid', async () => {
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

    // Constructor initializes lastSyncedAccountId='account-1' from settings,
    // then syncForCurrentSelection finds missing auth.json and restores snapshot
    expect(store.updateSettings).toHaveBeenCalledWith({ activeCodexManagedAccountId: null })
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
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
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"tokens":"original"}\n'
    )
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

    // Simulate CLI refreshing the token in ~/.codex/auth.json
    writeFileSync(runtimeAuthPath, '{"tokens":"refreshed"}\n', 'utf-8')

    // Next sync should read back the refreshed token to managed storage
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe('{"tokens":"refreshed"}\n')
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"tokens":"refreshed"}\n')
  })

  it('skips read-back on first sync after restart (lastWrittenAuthJson is null)', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    // Pre-populate runtime with different content to simulate a CLI refresh while Orca was down
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

    // After restart, managed storage should NOT be overwritten by unknown runtime state
    expect(readFileSync(managedAuthPath, 'utf-8')).toBe('{"tokens":"original"}\n')
    // Runtime should be overwritten with managed (conservative behavior)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"tokens":"original"}\n')
  })

  it('skips read-back during account switch', async () => {
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

    // Switch to account-2 — runtime still has account-1 tokens
    settings.activeCodexManagedAccountId = 'account-2'
    service.syncForCurrentSelection()

    // Account-2's managed auth should NOT be contaminated with account-1's runtime tokens
    expect(readFileSync(managedAuthPath2, 'utf-8')).toBe('{"tokens":"account2"}\n')
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"tokens":"account2"}\n')
  })

  it('detects external login on managed→system-default transition', async () => {
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

    // External `codex auth login` overwrites runtime auth
    writeFileSync(runtimeAuthPath, '{"account":"external-login"}\n', 'utf-8')

    // Deselect managed account
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    // Should keep the external login, not restore stale system snapshot
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-login"}\n')
    // Snapshot should be deleted so next capture picks up the external login
    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(false)
  })

  it('does not clobber fresh tokens after clearLastWrittenAuthJson', async () => {
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"tokens":"original"}\n'
    )
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

    // Simulate re-auth: managed storage gets fresh tokens
    writeFileSync(managedAuthPath, '{"tokens":"reauthed"}\n', 'utf-8')

    // Clear tracking before sync (as CodexAccountService would)
    service.clearLastWrittenAuthJson()
    service.syncForCurrentSelection()

    // Fresh re-auth tokens should survive — not be clobbered by stale runtime read-back
    expect(readFileSync(managedAuthPath, 'utf-8')).toBe('{"tokens":"reauthed"}\n')
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"tokens":"reauthed"}\n')
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
