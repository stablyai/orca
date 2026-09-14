import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { setSourceControlActionDefault } from '../shared/source-control-ai-actions'
import {
  testState,
  createStore,
  dataFile,
  writeDataFile,
  readDataFile,
  makeRepo
} from './persistence-test-harness'

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
  // ── 3. Corrupt JSON → falls back to defaults ────────────────────────

  it('falls back to defaults when data file contains invalid JSON', async () => {
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{{invalid json', 'utf-8')

    const store = await createStore()
    expect(store.getRepos()).toEqual([])
    expect(store.getSettings().theme).toBe('system')
    expect(store.getSettings().experimentalNewWorktreeCardStyle).toBe(false)
  })

  // ── 4. Schema migration: merges with defaults ───────────────────────

  it('merges loaded data with defaults for missing fields', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo()],
      worktreeMeta: {},
      settings: { theme: 'dark' },
      githubCache: { pr: {}, issue: {} }
      // ui and workspaceSession intentionally omitted
    })

    const store = await createStore()
    // ui should have defaults
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(280)
    expect(ui.rightSidebarOpen).toBe(true)
    expect(ui.rightSidebarTab).toBe('explorer')
    // settings should preserve the overridden value
    expect(store.getSettings().theme).toBe('dark')
    // new fields get defaults when missing from persisted data
    expect(store.getSettings().editorAutoSave).toBe(false)
    expect(store.getSettings().editorAutoSaveDelayMs).toBe(1000)
    expect(store.getSettings().refreshLocalBaseRefOnWorktreeCreate).toBe(false)
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
    expect(store.getSettings().sourceControlViewMode).toBe('list')
    expect(store.getSettings().showGitIgnoredFiles).toBe(true)
    expect(store.getSettings().showTasksButton).toBe(true)
    expect(store.getSettings().showAutomationsButton).toBe(true)
    expect(store.getSettings().combinedDiffFileTreeVisibleByDefault).toBe(false)
    expect(store.getSettings().visibleTaskProviders).toEqual(['github', 'gitlab', 'linear', 'jira'])
    expect(store.getSettings().experimentalActivity).toBe(false)
    expect(store.getSettings().experimentalActivityDefaultedOffForAllUsers).toBe(true)
    expect(store.getSettings().experimentalTerminalAttention).toBe(false)
    expect(store.getSettings().notifications.customSoundPath).toBeNull()
    // repos should be loaded
    expect(store.getRepos()).toHaveLength(1)
  })

  it('migrates legacy commit-message AI settings to source-control AI on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        commitMessageAi: {
          enabled: true,
          agentId: 'cursor',
          selectedModelByAgent: { cursor: 'gpt-5.2' },
          selectedModelByAgentByHost: { 'ssh:conn-1': { cursor: 'remote-model' } },
          discoveredModelsByAgent: {
            cursor: [{ id: 'gpt-5.2', label: 'GPT 5.2' }]
          },
          discoveredModelsByAgentByHost: {
            'ssh:conn-1': {
              cursor: [{ id: 'remote-model', label: 'Remote Model' }]
            }
          },
          selectedThinkingByModel: { 'gpt-5.2': 'high' },
          customPrompt: 'Use Conventional Commits.',
          customAgentCommand: 'cursor-agent'
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const sourceControlAi = store.getSettings().sourceControlAi

    expect(sourceControlAi).toMatchObject({
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'gpt-5.2' },
      selectedThinkingByModel: { 'gpt-5.2': 'high' },
      customAgentCommand: 'cursor-agent',
      instructionsByOperation: {
        commitMessage: 'Use Conventional Commits.',
        pullRequest: '',
        branchName: 'Use Conventional Commits.'
      }
    })
    expect(sourceControlAi?.selectedModelByAgentByHost?.['ssh:conn-1']?.cursor).toBe('remote-model')
    expect(sourceControlAi?.discoveredModelsByAgent?.cursor?.[0]?.id).toBe('gpt-5.2')
    expect(sourceControlAi?.discoveredModelsByAgentByHost?.['ssh:conn-1']?.cursor?.[0]?.id).toBe(
      'remote-model'
    )
    expect(store.getSettings().commitMessageAi?.customPrompt).toBe('Use Conventional Commits.')
  })

  it('migrates first-work branch auto-rename on for existing profiles once', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { autoRenameBranchFromWork: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().autoRenameBranchFromWork).toBe(true)
    expect(store.getSettings().autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('preserves first-work branch auto-rename opt-outs after the default-on migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        autoRenameBranchFromWork: false,
        autoRenameBranchFromWorkDefaultedOn: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().autoRenameBranchFromWork).toBe(false)
    expect(store.getSettings().autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('does not let settings updates clear the first-work branch auto-rename migration guard', async () => {
    const store = await createStore()

    const updated = store.updateSettings({ autoRenameBranchFromWorkDefaultedOn: false })

    expect(updated.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('migrates inherited TUI scroll sensitivity defaults to one report on first load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalTuiScrollSensitivity: 3 },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().terminalTuiScrollSensitivity).toBe(1)
    expect(store.getSettings().terminalTuiScrollSensitivityDefaultedToOne).toBe(true)
    store.flush()
    expect((readDataFile() as PersistedState).settings.terminalTuiScrollSensitivity).toBe(1)
  })

  it('preserves TUI scroll sensitivity choices after the one-report migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        terminalTuiScrollSensitivity: 3,
        terminalTuiScrollSensitivityDefaultedToOne: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().terminalTuiScrollSensitivity).toBe(3)
    expect(store.getSettings().terminalTuiScrollSensitivityDefaultedToOne).toBe(true)
  })

  it('stamps the TUI scroll sensitivity migration guard on future updates', async () => {
    const store = await createStore()

    const updated = store.updateSettings({
      terminalTuiScrollSensitivity: 3,
      terminalTuiScrollSensitivityDefaultedToOne: false
    })

    expect(updated.terminalTuiScrollSensitivity).toBe(3)
    expect(updated.terminalTuiScrollSensitivityDefaultedToOne).toBe(true)
  })

  it('merges rollback commit-message AI writes into existing source-control AI on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        sourceControlAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'source-model' },
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: { 'source-model': 'medium' },
          customAgentCommand: 'codex',
          instructionsByOperation: {
            commitMessage: 'Source commit prompt',
            pullRequest: 'Preserve PR prompt'
          },
          modelOverridesByOperation: {
            pullRequest: {
              selectedModelByAgent: { claude: 'pr-model' },
              selectedThinkingByModel: { 'pr-model': 'high' }
            }
          },
          prCreationDefaults: {
            draft: true,
            openAfterCreate: true
          }
        },
        commitMessageAi: {
          enabled: false,
          agentId: 'claude',
          selectedModelByAgent: { claude: 'legacy-model' },
          selectedModelByAgentByHost: { 'ssh:conn-1': { claude: 'remote-legacy-model' } },
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: { 'legacy-model': 'high' },
          customPrompt: 'Rollback commit prompt',
          customAgentCommand: 'claude'
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const sourceControlAi = store.getSettings().sourceControlAi

    expect(sourceControlAi).toMatchObject({
      enabled: false,
      agentId: 'claude',
      selectedModelByAgent: { codex: 'source-model' },
      selectedThinkingByModel: { 'source-model': 'medium' },
      customAgentCommand: 'claude',
      instructionsByOperation: {
        commitMessage: 'Rollback commit prompt',
        pullRequest: 'Preserve PR prompt',
        branchName: 'Rollback commit prompt'
      },
      prCreationDefaults: {
        draft: true,
        openAfterCreate: true
      }
    })
    expect(sourceControlAi?.selectedModelByAgentByHost?.['ssh:conn-1']).toBeUndefined()
    expect(sourceControlAi?.modelOverridesByOperation?.commitMessage).toEqual({
      selectedModelByAgent: { claude: 'legacy-model' },
      selectedModelByAgentByHost: { 'ssh:conn-1': { claude: 'remote-legacy-model' } },
      selectedThinkingByModel: { 'legacy-model': 'high' }
    })
    expect(sourceControlAi?.modelOverridesByOperation?.pullRequest).toEqual({
      selectedModelByAgent: { claude: 'pr-model' },
      selectedThinkingByModel: { 'pr-model': 'high' }
    })
    expect(store.getSettings().commitMessageAi).toMatchObject({
      enabled: false,
      agentId: 'claude',
      selectedModelByAgent: { claude: 'legacy-model' },
      customPrompt: 'Rollback commit prompt',
      customAgentCommand: 'claude'
    })
    store.flush()
    const persisted = JSON.parse(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8'))
    expect(persisted.settings.sourceControlAi.actions.commitMessage).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}\n\nRollback commit prompt'
    })
    expect(persisted.settings.sourceControlAi.actions.branchName).toEqual({
      agentId: 'claude',
      commandInputTemplate: 'Rollback commit prompt\n\n{basePrompt}'
    })
  })

  it('does not let rollback projection clobber existing source-control action templates on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        sourceControlAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          customAgentCommand: '',
          instructionsByOperation: {
            commitMessage: '',
            pullRequest: '',
            branchName: ''
          },
          actions: {
            commitMessage: {
              agentId: 'codex',
              commandInputTemplate: 'use $best-commit-msg to write a commit'
            },
            branchName: {
              agentId: 'claude',
              commandInputTemplate: 'name this branch from {firstPrompt}'
            }
          },
          prCreationDefaults: {}
        },
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          customPrompt: 'use $best-commit-msg to write a commit',
          customAgentCommand: ''
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().sourceControlAi?.actions?.commitMessage).toEqual({
      agentId: 'codex',
      commandInputTemplate: 'use $best-commit-msg to write a commit'
    })
    expect(store.getSettings().sourceControlAi?.actions?.branchName).toEqual({
      agentId: 'claude',
      commandInputTemplate: 'name this branch from {firstPrompt}'
    })
  })

  it('keeps a cleared global commit-message recipe template after persistence re-read', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          customPrompt: '모든 커밋 메시지는 한국어로 작성한다',
          customAgentCommand: ''
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const current = store.getSettings().sourceControlAi!
    store.updateSettings({
      sourceControlAi: {
        ...current,
        actions: setSourceControlActionDefault(current.actions, 'commitMessage', {
          commandInputTemplate: '{basePrompt}'
        })
      }
    })
    store.flush()

    const reopened = await createStore()
    expect(reopened.getSettings().sourceControlAi?.actions?.commitMessage).toMatchObject({
      commandInputTemplate: '{basePrompt}'
    })
    expect(reopened.getSettings().commitMessageAi?.customPrompt).toBe('')
  }, 10_000)

  it('normalizes malformed visible task providers on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { visibleTaskProviders: ['gitlab', 'unknown', 'gitlab'] },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().visibleTaskProviders).toEqual(['gitlab', 'jira'])
  })

  it('preserves a deliberate Jira provider opt-out after migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        visibleTaskProviders: ['gitlab'],
        visibleTaskProvidersDefaultedForJira: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().visibleTaskProviders).toEqual(['gitlab'])
  })

  it('normalizes malformed terminal shortcut policy on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalShortcutPolicy: 'terminal-maybe' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().terminalShortcutPolicy).toBe('orca-first')
  })

  it('normalizes malformed source control group order on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { sourceControlGroupOrder: 'tracked-first' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().sourceControlGroupOrder).toBe('changes-first')
  })

  it('repairs drifted task provider defaults on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { visibleTaskProviders: ['linear'], defaultTaskSource: 'github' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().defaultTaskSource).toBe('github')
    expect(store.getSettings().visibleTaskProviders).toEqual(['github', 'linear', 'jira'])
  })

  it('normalizes invalid task provider defaults on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { visibleTaskProviders: ['gitlab'], defaultTaskSource: 'bitbucket' as never },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().defaultTaskSource).toBe('gitlab')
    expect(store.getSettings().visibleTaskProviders).toEqual(['gitlab', 'jira'])
  })

  it('normalizes persisted open-in applications on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        openInApplications: [
          { id: 'cursor', label: ' Cursor ', command: ' cursor ' },
          { id: 'cursor', label: 'Dup', command: 'dup' },
          { id: '', label: 'Zed', command: 'zed' },
          { id: 'bad', label: ' ', command: 'bad' }
        ]
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().openInApplications).toEqual([
      { id: 'cursor', label: 'Cursor', command: 'cursor' },
      { id: 'open-in-3', label: 'Zed', command: 'zed' }
    ])
  })
})
