import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { PersistedState } from '../shared/persisted-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  collectPropertyPaths,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from './local-worktree-scan-generation'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // ── 9. Settings: get/update ────────────────────────────────────────

  it('updateSettings merges partial updates', async () => {
    const store = await createStore()
    const initial = store.getSettings()
    expect(initial.theme).toBe('system')

    const updated = store.updateSettings({
      theme: 'dark',
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1500,
      appFontFamily: 'Inter',
      terminalFontSize: 16,
      terminalFontWeight: 600,
      terminalFontWeightBold: 800
    })
    expect(updated.theme).toBe('dark')
    expect(updated.editorAutoSave).toBe(true)
    expect(updated.editorAutoSaveDelayMs).toBe(1500)
    expect(updated.appFontFamily).toBe('Inter')
    expect(updated.terminalFontSize).toBe(16)
    expect(updated.terminalFontWeight).toBe(600)
    expect(updated.terminalFontWeightBold).toBe(800)
    // Other fields preserved
    expect(updated.branchPrefix).toBe('git-username')
  })

  it('persists the agent skill sharing capability as an exact boolean', async () => {
    const store = await createStore()

    expect(store.updateSettings({ agentSkillSharingEnabled: true }).agentSkillSharingEnabled).toBe(
      true
    )
    expect(
      store.updateSettings({ agentSkillSharingEnabled: 'yes' as never }).agentSkillSharingEnabled
    ).toBe(false)
    expect(
      store.updateSettings({ agentSkillSharingEnabled: 1 as never }).agentSkillSharingEnabled
    ).toBe(false)
  })

  it('normalizes bot-author overrides on load and every settings write', async () => {
    writeDataFile({
      settings: {
        prBotAuthorOverrides: [' GretelFlux ', 'gretelflux', 42, '', 'another-bot']
      }
    })
    const store = await createStore()

    expect(store.getSettings().prBotAuthorOverrides).toEqual(['another-bot', 'gretelflux'])

    const oversized = Array.from(
      { length: 600 },
      (_, index) => ` bot-${String(index).padStart(4, '0')} `
    )
    const updated = store.updateSettings({ prBotAuthorOverrides: oversized })

    expect(updated.prBotAuthorOverrides).toHaveLength(500)
    expect(updated.prBotAuthorOverrides[0]).toBe('bot-0000')
    expect(updated.prBotAuthorOverrides[499]).toBe('bot-0499')
  })

  it('normalizes custom mobile pairing addresses on load and every settings write', async () => {
    writeDataFile({
      settings: {
        mobilePairingCustomAddress: 'host:99999',
        mobilePairingCustomAddresses: [' first.example:6768 ', 'host:99999', 'first.example:6768']
      }
    })
    const store = await createStore()

    expect(store.getSettings().mobilePairingCustomAddress).toBeNull()
    expect(store.getSettings().mobilePairingCustomAddresses).toEqual(['first.example:6768'])
    store.flush()
    expect(
      (readDataFile() as { settings?: GlobalSettings }).settings?.mobilePairingCustomAddress
    ).toBeNull()

    const updated = store.updateSettings({
      mobilePairingCustomAddress: ' 100.126.117.25:6768 '
    })
    expect(updated.mobilePairingCustomAddress).toBe('100.126.117.25:6768')
    expect(updated.mobilePairingCustomAddresses).toEqual([
      'first.example:6768',
      '100.126.117.25:6768'
    ])
    store.flush()
    expect(
      (readDataFile() as { settings?: GlobalSettings }).settings?.mobilePairingCustomAddress
    ).toBe('100.126.117.25:6768')

    expect(
      store.updateSettings({ mobilePairingCustomAddress: 42 as never }).mobilePairingCustomAddress
    ).toBeNull()

    expect(
      store.updateSettings({
        mobilePairingCustomAddresses: [' second.example ', 'host:99999', 'second.example']
      }).mobilePairingCustomAddresses
    ).toEqual(['second.example'])

    expect(
      store.updateSettings({
        mobilePairingCustomAddress: 'active.example:6768',
        mobilePairingCustomAddresses: ['second.example']
      }).mobilePairingCustomAddresses
    ).toEqual(['second.example', 'active.example:6768'])

    expect(
      store.updateSettings({
        mobilePairingCustomAddresses: ['third.example']
      }).mobilePairingCustomAddresses
    ).toEqual(['third.example', 'active.example:6768'])
  })

  it('notifies settings listeners with changed keys only', async () => {
    const store = await createStore()
    const listener = vi.fn()
    store.onSettingsChanged(listener)

    store.updateSettings(
      {
        theme: 'dark',
        disabledTuiAgents: ['codex', 'not-real', 'codex'] as never
      },
      { notifyListeners: true, originWebContentsId: 42 }
    )

    expect(listener).toHaveBeenCalledWith(
      {
        theme: 'dark',
        disabledTuiAgents: ['codex']
      },
      expect.objectContaining({
        theme: 'dark',
        disabledTuiAgents: ['codex']
      }),
      42
    )
  })

  it('does not notify settings listeners for unchanged scalar updates', async () => {
    const store = await createStore()
    const listener = vi.fn()
    store.onSettingsChanged(listener)

    store.updateSettings({ theme: store.getSettings().theme }, { notifyListeners: true })

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not notify settings listeners unless requested by the producer', async () => {
    const store = await createStore()
    const listener = vi.fn()
    store.onSettingsChanged(listener)

    store.updateSettings({ theme: 'dark' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('invalidates local worktree scans when the global Windows runtime changes', async () => {
    writeDataFile({ repos: [makeRepo()] })
    const store = await createStore()
    const generation = getLocalWorktreeScanGeneration('r1')

    store.updateSettings({ theme: 'dark' })
    expect(isLocalWorktreeScanGenerationCurrent('r1', generation)).toBe(true)

    store.updateSettings({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(isLocalWorktreeScanGenerationCurrent('r1', generation)).toBe(false)
  })

  it('migrates missing terminal scrollback rows to the row default and writes back rows only', async () => {
    writeDataFile({ settings: {} })

    const store = await createStore()

    expect(store.getSettings().terminalScrollbackRows).toBe(5_000)

    store.flush()
    const persisted = readDataFile() as { settings?: Record<string, unknown> }
    expect(persisted.settings?.terminalScrollbackRows).toBe(5_000)
    expect(persisted.settings).not.toHaveProperty('terminalScrollbackBytes')
  })

  it('migrates legacy terminal scrollback byte presets by intent', async () => {
    writeDataFile({
      settings: {
        terminalScrollbackBytes: 25_000_000
      }
    })

    const store = await createStore()

    expect(store.getSettings().terminalScrollbackRows).toBe(10_000)

    store.flush()
    const persisted = readDataFile() as { settings?: Record<string, unknown> }
    expect(persisted.settings?.terminalScrollbackRows).toBe(10_000)
    expect(persisted.settings).not.toHaveProperty('terminalScrollbackBytes')
  })

  it('lets persisted terminal scrollback rows win over legacy bytes', async () => {
    writeDataFile({
      settings: {
        terminalScrollbackRows: 25_000,
        terminalScrollbackBytes: 100_000_000
      }
    })

    const store = await createStore()

    expect(store.getSettings().terminalScrollbackRows).toBe(25_000)

    store.flush()
    const persisted = readDataFile() as { settings?: Record<string, unknown> }
    expect(persisted.settings?.terminalScrollbackRows).toBe(25_000)
    expect(persisted.settings).not.toHaveProperty('terminalScrollbackBytes')
  })

  it('normalizes invalid and clamped terminal scrollback rows on load', async () => {
    writeDataFile({
      settings: {
        terminalScrollbackRows: '50000'
      }
    })

    const invalidStore = await createStore()
    expect(invalidStore.getSettings().terminalScrollbackRows).toBe(5_000)
    invalidStore.flush()

    writeDataFile({
      settings: {
        terminalScrollbackRows: 75_000
      }
    })

    const clampedStore = await createStore()
    expect(clampedStore.getSettings().terminalScrollbackRows).toBe(50_000)
  })

  it('normalizes terminal scrollback row updates and ignores stale byte updates', async () => {
    const store = await createStore()
    const listener = vi.fn()
    store.onSettingsChanged(listener)

    const updated = store.updateSettings(
      {
        terminalScrollbackRows: 75_000,
        terminalScrollbackBytes: 250_000_000
      } as never,
      { notifyListeners: true }
    )

    expect(updated.terminalScrollbackRows).toBe(50_000)
    expect(listener).toHaveBeenCalledWith(
      { terminalScrollbackRows: 50_000 },
      expect.objectContaining({ terminalScrollbackRows: 50_000 }),
      undefined
    )

    store.updateSettings({ terminalScrollbackBytes: 10_000_000 } as never)
    store.flush()
    const persisted = readDataFile() as { settings?: Record<string, unknown> }
    expect(persisted.settings?.terminalScrollbackRows).toBe(50_000)
    expect(persisted.settings).not.toHaveProperty('terminalScrollbackBytes')
  })

  it('retires the persisted GitHub attribution setting without dropping unknown settings', async () => {
    const settledStore = await createStore()
    settledStore.flush()
    const settled = readDataFile() as { settings: Record<string, unknown> }
    settled.settings.enableGitHubAttribution = true
    settled.settings.futureSetting = { enabled: true }
    writeDataFile(settled)

    vi.useFakeTimers()
    try {
      const store = await createStore()

      expect(store.getSettings()).not.toHaveProperty('enableGitHubAttribution')
      expect(store.getSettings()).toHaveProperty('futureSetting', { enabled: true })
      vi.advanceTimersByTime(5_000)
      await store.waitForPendingWrite()
    } finally {
      vi.useRealTimers()
    }
    const persisted = readDataFile() as { settings?: Record<string, unknown> }
    expect(persisted.settings).not.toHaveProperty('enableGitHubAttribution')
    expect(persisted.settings).toHaveProperty('futureSetting', { enabled: true })
  })

  it('ignores retired GitHub attribution updates and strips stale in-memory values on save', async () => {
    const store = await createStore()
    const listener = vi.fn()
    store.onSettingsChanged(listener)

    const updated = store.updateSettings({ enableGitHubAttribution: true } as never, {
      notifyListeners: true
    })

    expect(updated).not.toHaveProperty('enableGitHubAttribution')
    expect(listener).not.toHaveBeenCalled()
    const settings = store.getSettings() as GlobalSettings & Record<string, unknown>
    settings.enableGitHubAttribution = false
    settings.futureSetting = 'kept'
    store.flush()
    const persisted = readDataFile() as { settings?: Record<string, unknown> }
    expect(persisted.settings).not.toHaveProperty('enableGitHubAttribution')
    expect(persisted.settings?.futureSetting).toBe('kept')
  })

  it('normalizes terminal cursor style before persistence and listener broadcasts', async () => {
    const store = await createStore()
    store.updateSettings({ terminalCursorStyle: 'underline' })
    const listener = vi.fn()
    store.onSettingsChanged(listener)

    const invalid = store.updateSettings(
      { terminalCursorStyle: 'beam' as never },
      { notifyListeners: true }
    )

    expect(invalid.terminalCursorStyle).toBe('block')
    expect(invalid.terminalCursorStyleDefaultedToBlock).toBe(true)
    expect(listener).toHaveBeenCalledWith(
      {
        terminalCursorStyle: 'block'
      },
      expect.objectContaining({ terminalCursorStyle: 'block' }),
      undefined
    )

    const valid = store.updateSettings(
      { terminalCursorStyle: 'underline' },
      { notifyListeners: true }
    )
    expect(valid.terminalCursorStyle).toBe('underline')
    expect(listener).toHaveBeenLastCalledWith(
      { terminalCursorStyle: 'underline' },
      expect.objectContaining({ terminalCursorStyle: 'underline' }),
      undefined
    )

    store.flush()
    expect((readDataFile() as PersistedState).settings.terminalCursorStyle).toBe('underline')
  })

  it('normalizes disabled TUI agents on load and update', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({
        settings: {
          disabledTuiAgents: ['codex', 'not-real', 'codex', 'claude']
        }
      })
    )
    const store = await createStore()

    expect(store.getSettings().disabledTuiAgents).toEqual(['codex', 'claude', 'claude-agent-teams'])

    const updated = store.updateSettings({
      disabledTuiAgents: ['gemini', 'not-real', 'gemini', 'opencode'] as never
    })
    expect(updated.disabledTuiAgents).toEqual(['gemini', 'opencode'])
  })

  it('enables Claude Agent Teams by default for fresh installs', async () => {
    const store = await createStore()

    expect(store.getSettings().disabledTuiAgents).toEqual([])
    expect(store.getSettings().claudeAgentTeamsDefaultDisabledMigrated).toBe(true)
  })

  it('migrates yolo default args onto untouched agent launch settings', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({
        settings: {
          agentCmdOverrides: {}
        }
      })
    )
    const store = await createStore()

    expect(store.getSettings().agentDefaultArgs).toMatchObject({
      claude: '--dangerously-skip-permissions',
      codex: '--dangerously-bypass-approvals-and-sandbox',
      cursor: '--yolo'
    })
    expect(store.getSettings().agentDefaultEnv).toMatchObject({
      goose: { GOOSE_MODE: 'auto' }
    })
    expect(store.getSettings().agentYoloDefaultsMigrated).toBe(true)
  })

  it('does not add yolo defaults for legacy agents with command overrides', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({
        settings: {
          agentCmdOverrides: {
            codex: 'codex --profile work',
            goose: 'goose'
          }
        }
      })
    )
    const store = await createStore()

    expect(store.getSettings().agentDefaultArgs?.codex).toBe('')
    expect(store.getSettings().agentDefaultEnv?.goose).toEqual({})
    expect(store.getSettings().agentDefaultArgs?.claude).toBe('--dangerously-skip-permissions')
  })

  it('removes unsupported TUI skip-permissions args from migrated profiles', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({
        settings: {
          agentYoloDefaultsMigrated: true,
          agentDefaultArgs: {
            opencode: '--dangerously-skip-permissions --model opencode/gpt-5',
            kilo: '--dangerously-skip-permissions',
            codex: '--dangerously-bypass-approvals-and-sandbox'
          }
        }
      })
    )
    const store = await createStore()
    store.flush()

    expect(store.getSettings().agentDefaultArgs?.opencode).toBe('--model opencode/gpt-5')
    expect(store.getSettings().agentDefaultArgs?.kilo).toBe('')
    expect(store.getSettings().agentDefaultArgs?.codex).toBe(
      '--dangerously-bypass-approvals-and-sandbox'
    )
    expect((readDataFile() as PersistedState).settings.agentDefaultArgs?.opencode).toBe(
      '--model opencode/gpt-5'
    )
    expect((readDataFile() as PersistedState).settings.agentDefaultArgs?.kilo).toBe('')
  })

  it('normalizes app icon on load and update', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({
        settings: {
          appIcon: 'not-real'
        }
      })
    )
    const store = await createStore()

    expect(store.getSettings().appIcon).toBe('classic')

    expect(store.updateSettings({ appIcon: 'watercolor' }).appIcon).toBe('watercolor')
    expect(store.updateSettings({ appIcon: 'blue' }).appIcon).toBe('blue')
    expect(store.updateSettings({ appIcon: 'not-real' as never }).appIcon).toBe('classic')
  })

  it('updateSettings keeps the legacy commit-message AI projection in sync', async () => {
    const store = await createStore()
    const current = store.getSettings().sourceControlAi!

    const updated = store.updateSettings({
      sourceControlAi: {
        ...current,
        enabled: true,
        agentId: 'codex',
        selectedModelByAgent: { codex: 'gpt-5.4' },
        selectedThinkingByModel: { 'gpt-5.4': 'high' },
        instructionsByOperation: {
          commitMessage: 'Write concise commit messages.',
          pullRequest: 'Write release-note-ready PR details.'
        },
        customAgentCommand: ''
      }
    })

    expect(updated.commitMessageAi).toMatchObject({
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4' },
      selectedThinkingByModel: { 'gpt-5.4': 'high' },
      customPrompt: 'Write concise commit messages.',
      customAgentCommand: ''
    })
  })

  it('updateSettings keeps source-control AI in sync for legacy commit-message updates', async () => {
    const store = await createStore()
    const current = store.getSettings().commitMessageAi!

    const updated = store.updateSettings({
      commitMessageAi: {
        ...current,
        enabled: false,
        agentId: 'claude',
        selectedModelByAgent: { claude: 'sonnet' },
        selectedThinkingByModel: { sonnet: 'medium' },
        customPrompt: 'Legacy settings update',
        customAgentCommand: 'claude'
      }
    })

    expect(updated.sourceControlAi).toMatchObject({
      enabled: false,
      agentId: 'claude',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: 'claude',
      instructionsByOperation: {
        commitMessage: 'Legacy settings update',
        branchName: 'Legacy settings update'
      }
    })
    expect(updated.sourceControlAi?.modelOverridesByOperation?.commitMessage).toEqual({
      selectedModelByAgent: { claude: 'sonnet' },
      selectedThinkingByModel: { sonnet: 'medium' }
    })
  })

  it('updateSettings normalizes open-in applications', async () => {
    const store = await createStore()
    const updated = store.updateSettings({
      openInApplications: [
        { id: 'cursor', label: ' Cursor ', command: ' cursor ' },
        { id: 'cursor', label: 'Dup', command: 'dup' },
        { id: 'bad', label: '', command: 'bad' }
      ]
    })
    expect(updated.openInApplications).toEqual([
      { id: 'cursor', label: 'Cursor', command: 'cursor' }
    ])
  })

  it('updateSettings deep-merges and clamps notification custom sound volume', async () => {
    const store = await createStore()
    const updated = store.updateSettings({
      notifications: {
        ...store.getSettings().notifications,
        customSoundVolume: -20
      }
    })

    expect(updated.notifications.customSoundVolume).toBe(0)
    expect(updated.notifications.enabled).toBe(true)
    expect(updated.notifications.customSoundPath).toBeNull()
  })

  it('updateSettings toggles editorAutoSave', async () => {
    const store = await createStore()
    expect(store.getSettings().editorAutoSave).toBe(false)

    store.updateSettings({ editorAutoSave: true })
    expect(store.getSettings().editorAutoSave).toBe(true)

    store.updateSettings({ editorAutoSave: false })
    expect(store.getSettings().editorAutoSave).toBe(false)
  })

  it('keeps legacy rightSidebarOpenByDefault writable for backward compatibility', async () => {
    const store = await createStore()
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)

    store.updateSettings({ rightSidebarOpenByDefault: false })
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(false)

    store.updateSettings({ rightSidebarOpenByDefault: true })
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
  })

  it('updateSettings persists sourceControlViewMode as a user setting', async () => {
    const store = await createStore()
    expect(store.getSettings().sourceControlViewMode).toBe('list')

    store.updateSettings({ sourceControlViewMode: 'tree' })
    expect(store.getSettings().sourceControlViewMode).toBe('tree')
  })

  it('updateSettings persists sourceControlGroupOrder as a user setting', async () => {
    const store = await createStore()
    expect(store.getSettings().sourceControlGroupOrder).toBe('changes-first')

    store.updateSettings({ sourceControlGroupOrder: 'staged-first' })
    expect(store.getSettings().sourceControlGroupOrder).toBe('staged-first')

    store.updateSettings({ sourceControlGroupOrder: 'tracked-first' as never })
    expect(store.getSettings().sourceControlGroupOrder).toBe('changes-first')
  })

  it('updateSettings normalizes terminal shortcut policy', async () => {
    const store = await createStore()

    store.updateSettings({ terminalShortcutPolicy: 'terminal-first' })
    expect(store.getSettings().terminalShortcutPolicy).toBe('terminal-first')

    store.updateSettings({ terminalShortcutPolicy: 'terminal-maybe' as never })
    expect(store.getSettings().terminalShortcutPolicy).toBe('orca-first')
  })

  it('reloads sourceControlViewMode from global settings without touching workspace state', async () => {
    const workspaceSession = {
      activeRepoId: 'r1',
      activeWorktreeId: 'repo1::/worktree-a',
      activeTabId: 'tab1',
      tabsByWorktree: {
        'repo1::/worktree-a': [
          makeTerminalTab({
            id: 'tab1',
            worktreeId: 'repo1::/worktree-a'
          })
        ],
        'repo1::/worktree-b': [
          makeTerminalTab({
            id: 'tab2',
            worktreeId: 'repo1::/worktree-b'
          })
        ]
      },
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {},
      markdownFrontmatterVisible: {},
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      activeBrowserTabIdByWorktree: {},
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: {},
      browserUrlHistory: [],
      defaultTerminalTabsAppliedByWorktreeId: {}
    }
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: 'repo1', path: '/repo1' })],
      worktreeMeta: {
        'repo1::/worktree-a': { status: 'active' },
        'repo1::/worktree-b': { status: 'active' }
      },
      settings: { theme: 'dark' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession
    })

    const store = await createStore()
    expect(store.getSettings().sourceControlViewMode).toBe('list')
    expect(store.getSettings().sourceControlGroupOrder).toBe('changes-first')

    store.updateSettings({ sourceControlViewMode: 'tree', sourceControlGroupOrder: 'staged-first' })
    store.flush()

    const persisted = readDataFile() as {
      settings?: { sourceControlGroupOrder?: string; sourceControlViewMode?: string }
      workspaceSession?: typeof workspaceSession
      worktreeMeta?: Record<string, unknown>
    }
    expect(persisted.settings?.sourceControlViewMode).toBe('tree')
    expect(persisted.settings?.sourceControlGroupOrder).toBe('staged-first')
    expect(persisted.workspaceSession).toEqual({
      ...getDefaultWorkspaceSession(),
      ...workspaceSession
    })
    expect(persisted.worktreeMeta).toEqual({
      'repo1::/worktree-a': { status: 'active' },
      'repo1::/worktree-b': { status: 'active' }
    })
    expect(collectPropertyPaths(persisted, 'sourceControlViewMode')).toEqual([
      'settings.sourceControlViewMode'
    ])
    expect(collectPropertyPaths(persisted, 'sourceControlGroupOrder')).toEqual([
      'settings.sourceControlGroupOrder'
    ])

    const reloaded = await createStore()
    expect(reloaded.getSettings().sourceControlViewMode).toBe('tree')
    expect(reloaded.getSettings().sourceControlGroupOrder).toBe('staged-first')
    expect(reloaded.getWorkspaceSession().activeWorktreeId).toBe('repo1::/worktree-a')
  })
})
