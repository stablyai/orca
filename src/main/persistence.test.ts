/* eslint-disable max-lines -- Why: this persistence suite keeps defaulting,
migration, mutation, and flush behavior in one file so schema changes are
reviewed against the full storage contract instead of being scattered. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  realpathSync,
  symlinkSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type {
  PersistedState,
  Project,
  ProjectGroup,
  ProjectHostSetup,
  Repo,
  TerminalPaneLayoutNode,
  TerminalTab,
  WorktreeLineage,
  WorkspaceLineage,
  WorkspaceSessionState
} from '../shared/types'
import { isTerminalLeafId, makePaneKey } from '../shared/stable-pane-id'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import { MAX_BROWSER_HISTORY_ENTRIES } from '../shared/workspace-session-browser-history'
import {
  getDefaultPersistedState,
  getDefaultWorkspaceSession,
  ONBOARDING_FINAL_STEP,
  ONBOARDING_FLOW_VERSION
} from '../shared/constants'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../shared/execution-host'
import { SshConnectionStore } from './ssh/ssh-connection-store'
import { setSourceControlActionDefault } from '../shared/source-control-ai-actions'

// Shared mutable state so the electron mock can reference a per-test directory
const testState = { dir: '' }

// Stub the ~/.ssh/config parser so the SSH-import integration test below drives
// the real Store (real normalizeSshTarget + disk round-trip) with deterministic
// config hosts instead of the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const TEST_LEAF_1 = '11111111-1111-4111-8111-111111111111'
const TEST_LEAF_2 = '22222222-2222-4222-8222-222222222222'
const TEST_LEAF_LIVE = '33333333-3333-4333-8333-333333333333'
const TEST_LEAF_EXPIRED = '44444444-4444-4444-8444-444444444444'
const REORDERED_DEFAULT_WORKSPACE_STATUSES = [
  { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' },
  { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
  {
    id: 'in-progress',
    label: 'In progress',
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
]
const LEGACY_DEFAULT_WORKSPACE_STATUSES = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' },
  { id: 'in-review', label: 'In review', color: 'violet', icon: 'git-pull-request' },
  { id: 'completed', label: 'Completed', color: 'emerald', icon: 'circle-check' }
]
const WORKFLOW_DEFAULT_WORKSPACE_STATUSES = [
  { id: 'completed', label: 'Done', color: 'conductor-done', icon: 'conductor-done' },
  { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
  {
    id: 'in-progress',
    label: 'In progress',
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
]

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

vi.mock('./git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

/** Reset modules and dynamically import Store so the data-file path picks up the current testState.dir */
async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  }
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf-8')
}

function readDataFile(): unknown {
  return JSON.parse(readFileSync(dataFile(), 'utf-8'))
}

function symlinkDirectorySync(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

function collectPropertyPaths(value: unknown, property: string, prefix = ''): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const paths: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (key === property) {
      paths.push(path)
    }
    paths.push(...collectPropertyPaths(child, property, path))
  }
  return paths
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeProjectHostSetup = (overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup => ({
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: '',
  path: '/repo',
  displayName: 'Project',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeTerminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab1',
  ptyId: 'pty1',
  worktreeId: 'repo1::/worktree',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...overrides
})

const makeWorktreeLineage = (overrides: Partial<WorktreeLineage> = {}): WorktreeLineage => ({
  worktreeId: 'r1::/path/child',
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: 'r1::/path/parent',
  parentWorktreeInstanceId: 'parent-instance',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1,
  ...overrides
})

const makeWorkspaceLineage = (overrides: Partial<WorkspaceLineage> = {}): WorkspaceLineage => ({
  childWorkspaceKey: worktreeWorkspaceKey('r1::/path/child'),
  childInstanceId: 'child-instance',
  parentWorkspaceKey: folderWorkspaceKey('folder-1'),
  parentInstanceId: null,
  origin: 'cli',
  capture: { source: 'env-workspace', confidence: 'inferred' },
  createdAt: 1,
  ...overrides
})

function makeSessionWithTerminalBuffers(): WorkspaceSessionState {
  return {
    activeRepoId: 'local-repo',
    activeWorktreeId: 'local-repo::/local',
    activeTabId: 'local-tab',
    tabsByWorktree: {
      'local-repo::/local': [
        makeTerminalTab({
          id: 'local-tab',
          ptyId: 'local-pty',
          worktreeId: 'local-repo::/local'
        })
      ],
      'remote-repo::/remote': [
        makeTerminalTab({
          id: 'remote-tab',
          ptyId: 'remote-pty',
          worktreeId: 'remote-repo::/remote'
        })
      ]
    },
    terminalLayoutsByTabId: {
      'local-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        buffersByLeafId: { [TEST_LEAF_1]: 'local-scrollback' },
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'local-pty' }
      },
      'remote-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_2 },
        activeLeafId: TEST_LEAF_2,
        expandedLeafId: null,
        buffersByLeafId: { [TEST_LEAF_2]: 'remote-scrollback' },
        ptyIdsByLeafId: { [TEST_LEAF_2]: 'remote-pty' }
      }
    }
  }
}

function makeSessionWithBrowserHistory(count: number): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    browserUrlHistory: Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/${index}`,
      normalizedUrl: `https://example.com/${index}`,
      title: `Example ${index} ${'x'.repeat(200)}`,
      lastVisitedAt: 1_700_000_000_000 - index,
      visitCount: 1
    }))
  }
}

function makeBalancedLegacyPaneLayout(start: number, end: number): TerminalPaneLayoutNode {
  if (end - start === 1) {
    return { type: 'leaf', leafId: `pane:${start + 1}` }
  }
  const midpoint = Math.floor((start + end) / 2)
  return {
    type: 'split',
    direction: 'horizontal',
    first: makeBalancedLegacyPaneLayout(start, midpoint),
    second: makeBalancedLegacyPaneLayout(midpoint, end)
  }
}

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

  // ── 1. Defaults when no file exists ──────────────────────────────────

  it('returns empty repos when no data file exists', async () => {
    const store = await createStore()
    expect(store.getRepos()).toEqual([])
  }, 15_000)

  it('backfills project host setup compatibility records from legacy repos on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'local-repo',
          path: '/Users/alice/orca',
          displayName: 'Orca',
          upstream: { owner: 'StablyAI', repo: 'Orca' }
        }),
        makeRepo({
          id: 'remote-repo',
          path: '/home/alice/orca',
          displayName: 'orca',
          connectionId: 'gpu-vm',
          upstream: { owner: 'stablyai', repo: 'orca' }
        })
      ]
    })

    const store = await createStore()

    expect(store.getProjects()).toEqual([
      expect.objectContaining({
        id: 'github:stablyai/orca',
        sourceRepoIds: ['local-repo', 'remote-repo']
      })
    ])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({
        id: 'local-repo',
        projectId: 'github:stablyai/orca',
        hostId: 'local',
        path: '/Users/alice/orca'
      }),
      expect.objectContaining({
        id: 'remote-repo',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:gpu-vm',
        path: '/home/alice/orca'
      })
    ])

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.projects).toEqual(store.getProjects())
    expect(persisted.projectHostSetups).toEqual(store.getProjectHostSetups())
  })

  it('preserves independent project host setup records on load', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ id: 'r1', path: '/repo', displayName: 'Repo' })],
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })

    const store = await createStore()

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r1', 'cloud-project'])
    expect(store.getProjectHostSetups().map((setup) => setup.id)).toEqual([
      'r1',
      'cloud-project::gpu-vm'
    ])
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.projectHostSetups).toContainEqual(independentSetup)
  })

  it('updates and persists a project Windows runtime preference', async () => {
    const project = makeProject({
      id: 'project-1',
      sourceRepoIds: ['r1'],
      localWindowsRuntimePreference: { kind: 'inherit-global' }
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [project],
      projectHostSetups: [
        makeProjectHostSetup({
          id: 'setup-1',
          projectId: project.id,
          repoId: ''
        })
      ]
    })
    const store = await createStore()

    const updated = store.updateProject('project-1', {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(updated?.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getProjects()[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
  })

  it('migrates legacy WSL agent settings into the global Windows runtime default', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      }
    })

    const store = await createStore()

    expect(store.getSettings().localWindowsRuntimeDefault).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    store.flush()
    expect((readDataFile() as PersistedState).settings.localWindowsRuntimeDefault).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
  })

  it('returns default settings when no data file exists', async () => {
    const store = await createStore()
    const settings = store.getSettings()
    expect(settings.branchPrefix).toBe('git-username')
    expect(settings.refreshLocalBaseRefOnWorktreeCreate).toBe(false)
    expect(settings.theme).toBe('system')
    expect(settings.appIcon).toBe('classic')
    expect(settings.appFontFamily).toBe('Geist')
    expect(settings.editorAutoSave).toBe(false)
    expect(settings.editorAutoSaveDelayMs).toBe(1000)
    expect(settings.terminalFontSize).toBe(14)
    expect(settings.terminalFontWeight).toBe(500)
    expect(settings.terminalUseSeparateLightTheme).toBe(true)
    expect(settings.rightSidebarOpenByDefault).toBe(true)
    expect(settings.showTasksButton).toBe(true)
    expect(settings.showAutomationsButton).toBe(true)
    expect(settings.visibleTaskProviders).toEqual(['github', 'gitlab', 'linear', 'jira'])
    expect(settings.openInApplications).toEqual([
      { id: 'vscode', label: 'VS Code', command: 'code' }
    ])
    expect(settings.experimentalActivity).toBe(false)
    expect(settings.experimentalActivityDefaultedOffForAllUsers).toBe(true)
    expect(settings.experimentalTerminalAttention).toBe(false)
    expect(settings.floatingTerminalEnabled).toBe(true)
    expect(settings.floatingTerminalDefaultedForAllUsers).toBe(true)
    expect(settings.notifications.customSoundPath).toBeNull()
    expect(settings.notifications.customSoundVolume).toBe(100)
    expect(settings.notifications.suppressWhenFocused).toBe(true)
  })

  it('returns default UI state when no data file exists', async () => {
    const store = await createStore()
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(280)
    expect(ui.rightSidebarOpen).toBe(true)
    expect(ui.rightSidebarTab).toBe('explorer')
    expect(ui.groupBy).toBe('repo')
    expect(ui.lastActiveRepoId).toBeNull()
    expect(ui.dismissedUpdateVersion).toBeNull()
    expect(ui.lastUpdateCheckAt).toBeNull()
    expect(ui.setupGuideSidebarDismissed).toBe(false)
    expect(ui.setupGuideBrowserMilestoneMigrated).toBe(true)
    expect(ui.setupGuideBrowserMilestoneLegacyComplete).toBe(false)
  })

  it('hides the setup guide sidebar entry for existing users backfilled as completed', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: {}
    })

    const store = await createStore()
    const onboarding = store.getOnboarding()

    expect(onboarding.closedAt).not.toBeNull()
    expect(onboarding.outcome).toBe('completed')
    expect(onboarding.lastCompletedStep).toBe(ONBOARDING_FINAL_STEP)
    expect(store.getUI().setupGuideSidebarDismissed).toBe(true)
    expect(store.getUI().setupGuideBrowserMilestoneMigrated).toBe(false)
    expect(store.getUI().setupGuideBrowserMilestoneLegacyComplete).toBe(false)
  })

  it('persists the existing-user onboarding backfill back to disk', async () => {
    // Why: the upgrade-cohort backfill is derived at load; this asserts the
    // backfilled onboarding+gate state round-trips through a write intact (the
    // load-time scheduleSave that triggers it without a manual flush is wired
    // via loadNeedsSave at the no-onboarding-block branch).
    writeDataFile({
      schemaVersion: 1,
      ui: {}
    })

    const store = await createStore()
    store.flush()
    const persisted = readDataFile() as {
      onboarding?: { closedAt: number | null; outcome: string | null; lastCompletedStep: number }
      ui?: { setupGuideSidebarDismissed?: boolean }
    }

    expect(persisted.onboarding?.closedAt).not.toBeNull()
    expect(persisted.onboarding?.outcome).toBe('completed')
    expect(persisted.onboarding?.lastCompletedStep).toBe(ONBOARDING_FINAL_STEP)
    expect(persisted.ui?.setupGuideSidebarDismissed).toBe(true)
  })

  it('keeps the setup guide sidebar entry available while onboarding is open', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: null,
        outcome: null,
        lastCompletedStep: -1,
        checklist: {}
      },
      ui: {}
    })

    const store = await createStore()

    expect(store.getOnboarding().closedAt).toBeNull()
    expect(store.getUI().setupGuideSidebarDismissed).toBe(false)
  })

  it('treats persisted false setup guide sidebar dismissal as stale once onboarding is closed', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: 123,
        outcome: 'dismissed',
        lastCompletedStep: 2,
        checklist: {}
      },
      ui: {
        setupGuideSidebarDismissed: false
      }
    })

    const store = await createStore()

    expect(store.getUI().setupGuideSidebarDismissed).toBe(true)
  })

  it('keeps malformed completed onboarding closed for the setup guide sidebar gate', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: 'yesterday',
        outcome: 'completed',
        lastCompletedStep: ONBOARDING_FINAL_STEP,
        checklist: {}
      },
      ui: {
        setupGuideSidebarDismissed: false
      }
    })

    const store = await createStore()
    const onboarding = store.getOnboarding()

    expect(onboarding.closedAt).not.toBeNull()
    expect(onboarding.outcome).toBe('completed')
    expect(onboarding.lastCompletedStep).toBe(ONBOARDING_FINAL_STEP)
    expect(store.getUI().setupGuideSidebarDismissed).toBe(true)
  })

  it('does not reopen the setup guide sidebar when closed onboarding has a null timestamp', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: null,
        outcome: 'dismissed',
        lastCompletedStep: 1,
        checklist: {}
      },
      ui: {}
    })

    const store = await createStore()

    expect(store.getOnboarding().closedAt).not.toBeNull()
    expect(store.getUI().setupGuideSidebarDismissed).toBe(true)
  })

  it('recovers a close timestamp when closed onboarding omits the closedAt key', async () => {
    // Why: a persisted block missing `closedAt` entirely (vs an explicit null)
    // must still stay closed via outcome recovery, guarding the
    // `'closedAt' in raw` sanitizer branch separately from the null case.
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        outcome: 'completed',
        lastCompletedStep: ONBOARDING_FINAL_STEP,
        checklist: {}
      },
      ui: {}
    })

    const store = await createStore()

    expect(store.getOnboarding().closedAt).not.toBeNull()
    expect(store.getUI().setupGuideSidebarDismissed).toBe(true)
  })

  it('does not mutate gate fields for a consistent closed-onboarding existing user', async () => {
    // Why: the gate must be idempotent. A user already persisted as
    // closed+completed must round-trip unchanged — the backfill path must not
    // fire and stomp the real closedAt with a fresh Date.now() each launch.
    const consistent = {
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: 123,
        outcome: 'completed',
        lastCompletedStep: ONBOARDING_FINAL_STEP,
        checklist: {}
      },
      ui: {
        setupGuideSidebarDismissed: true
      }
    }
    writeDataFile(consistent)

    const store = await createStore()
    expect(store.getUI().setupGuideSidebarDismissed).toBe(true)

    store.flush()
    const persisted = readDataFile() as typeof consistent

    // Flushing the loaded state preserves the persisted gate fields verbatim.
    expect(persisted.onboarding.closedAt).toBe(123)
    expect(persisted.onboarding.outcome).toBe('completed')
    expect(persisted.ui.setupGuideSidebarDismissed).toBe(true)
  })

  it.each([
    [3, 2],
    [4, 2],
    [5, 3],
    [6, 3],
    [9, 3]
  ])(
    'migrates unversioned seven-step onboarding progress %i before applying the current step bound',
    async (legacyStep, expectedStep) => {
      writeDataFile({
        onboarding: {
          closedAt: null,
          outcome: null,
          lastCompletedStep: legacyStep,
          checklist: {}
        }
      })

      const store = await createStore()
      const onboarding = store.getOnboarding()

      expect(onboarding.flowVersion).toBe(ONBOARDING_FLOW_VERSION)
      expect(onboarding.lastCompletedStep).toBe(expectedStep)
      expect(onboarding.closedAt).toBeNull()
      expect(onboarding.outcome).toBeNull()
    }
  )

  it.each([
    [3, 2],
    [4, 3],
    [5, 3],
    [9, 3]
  ])(
    'migrates versioned five-step onboarding progress %i before applying the current step bound',
    async (legacyStep, expectedStep) => {
      writeDataFile({
        onboarding: {
          flowVersion: 2,
          closedAt: null,
          outcome: null,
          lastCompletedStep: legacyStep,
          checklist: {}
        }
      })

      const store = await createStore()
      const onboarding = store.getOnboarding()

      expect(onboarding.flowVersion).toBe(ONBOARDING_FLOW_VERSION)
      expect(onboarding.lastCompletedStep).toBe(expectedStep)
      expect(onboarding.closedAt).toBeNull()
      expect(onboarding.outcome).toBeNull()
    }
  )

  it.each([
    [3, 3],
    [4, 4],
    [9, 4]
  ])(
    'migrates versioned four-step onboarding progress %i around the inserted Windows step',
    async (legacyStep, expectedStep) => {
      writeDataFile({
        onboarding: {
          flowVersion: 3,
          closedAt: null,
          outcome: null,
          lastCompletedStep: legacyStep,
          checklist: {}
        }
      })

      const store = await createStore()
      const onboarding = store.getOnboarding()

      expect(onboarding.flowVersion).toBe(ONBOARDING_FLOW_VERSION)
      expect(onboarding.lastCompletedStep).toBe(expectedStep)
      expect(onboarding.closedAt).toBeNull()
      expect(onboarding.outcome).toBeNull()
    }
  )

  it('keeps current onboarding progress marked as the five-step flow', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: null,
        outcome: null,
        lastCompletedStep: 3,
        checklist: {}
      }
    })

    const store = await createStore()
    const onboarding = store.getOnboarding()

    expect(onboarding.flowVersion).toBe(ONBOARDING_FLOW_VERSION)
    expect(onboarding.lastCompletedStep).toBe(3)
  })

  it('migrates legacy completed onboarding progress to the current final step', async () => {
    writeDataFile({
      onboarding: {
        closedAt: 1,
        outcome: 'completed',
        lastCompletedStep: 7,
        checklist: {}
      }
    })

    const store = await createStore()
    const onboarding = store.getOnboarding()

    expect(onboarding.flowVersion).toBe(ONBOARDING_FLOW_VERSION)
    expect(onboarding.outcome).toBe('completed')
    expect(onboarding.lastCompletedStep).toBe(ONBOARDING_FINAL_STEP)
  })

  it.each([
    [{ outcome: 'completed', lastCompletedStep: 7 }, 'completed', ONBOARDING_FINAL_STEP],
    [{ closedAt: null, outcome: 'dismissed', lastCompletedStep: 2 }, 'dismissed', 2],
    [
      { closedAt: 'invalid', outcome: 'completed', lastCompletedStep: 7 },
      'completed',
      ONBOARDING_FINAL_STEP
    ]
  ] as const)(
    'keeps closed onboarding closed when closedAt is missing or malformed',
    async (onboardingInput, expectedOutcome, expectedStep) => {
      writeDataFile({
        onboarding: {
          checklist: {},
          ...onboardingInput
        }
      })

      const store = await createStore()
      const onboarding = store.getOnboarding()

      expect(onboarding.closedAt).toEqual(expect.any(Number))
      expect(onboarding.outcome).toBe(expectedOutcome)
      expect(onboarding.lastCompletedStep).toBe(expectedStep)
    }
  )

  it('preserves legacy none grouping as ungrouped workspaces', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: { groupBy: 'none' }
    })
    const store = await createStore()
    expect(store.getUI().groupBy).toBe('none')
  })

  it('normalizes interim flat grouping back to none', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: { groupBy: 'flat' }
    })
    const store = await createStore()
    expect(store.getUI().groupBy).toBe('none')
  })

  it('preserves explicit workspace status grouping', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: { groupBy: 'workspace-status' }
    })
    const store = await createStore()
    expect(store.getUI().groupBy).toBe('workspace-status')
  })

  it('defaults projectOrderBy to manual when absent, even with recent sortBy', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: { sortBy: 'recent' }
    })
    const store = await createStore()
    expect(store.getUI().projectOrderBy).toBe('manual')
  })

  it('falls back invalid projectOrderBy to manual', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: { projectOrderBy: 'bogus' }
    })
    const store = await createStore()
    expect(store.getUI().projectOrderBy).toBe('manual')
  })

  it('preserves and round-trips an explicit recent projectOrderBy', async () => {
    writeDataFile({
      schemaVersion: 1,
      ui: { projectOrderBy: 'recent' }
    })
    const store = await createStore()
    expect(store.getUI().projectOrderBy).toBe('recent')

    store.updateUI({ projectOrderBy: 'manual' })
    expect(store.getUI().projectOrderBy).toBe('manual')
  })

  // ── 2. Load from existing valid file ─────────────────────────────────

  it('reads repos from an existing data file', async () => {
    const repo = makeRepo()
    writeDataFile({
      schemaVersion: 1,
      repos: [repo],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const repos = store.getRepos()
    expect(repos).toHaveLength(1)
    expect(repos[0].id).toBe('r1')
    expect(repos[0].gitUsername).toBe('testuser')
  })

  it('normalizes legacy remote workspace sync fields on SSH targets', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      sshTargets: [
        {
          id: 'ssh-disabled-legacy-grace',
          label: 'Disabled legacy grace',
          host: 'disabled.example.com',
          port: 22,
          username: 'dev',
          remoteWorkspaceSyncEnabled: false,
          remoteWorkspaceSyncGracePeriodSeconds: 0
        },
        {
          id: 'ssh-enabled-legacy-grace',
          label: 'Enabled legacy grace',
          host: 'enabled.example.com',
          port: 22,
          username: 'dev',
          remoteWorkspaceSyncEnabled: true,
          remoteWorkspaceSyncGracePeriodSeconds: 0
        },
        {
          id: 'ssh-synced-grace-wins-over-relay',
          label: 'Synced grace wins',
          host: 'new.example.com',
          port: 22,
          username: 'dev',
          relayGracePeriodSeconds: 120,
          remoteWorkspaceSyncEnabled: true,
          remoteWorkspaceSyncGracePeriodSeconds: 0
        },
        {
          id: 'ssh-form-default-relay-with-unlimited-sync',
          label: 'Form-default relay with unlimited sync',
          host: 'unlimited.example.com',
          port: 22,
          username: 'dev',
          relayGracePeriodSeconds: 10800,
          remoteWorkspaceSyncEnabled: true,
          remoteWorkspaceSyncGracePeriodSeconds: 0
        }
      ]
    })

    const store = await createStore()
    const targets = store.getSshTargets()

    expect(targets[0]).not.toHaveProperty('relayGracePeriodSeconds')
    expect(targets[1].relayGracePeriodSeconds).toBe(0)
    expect(targets[2].relayGracePeriodSeconds).toBe(0)
    expect(targets[3].relayGracePeriodSeconds).toBe(0)
    for (const target of targets) {
      expect(target).not.toHaveProperty('remoteWorkspaceSyncEnabled')
      expect(target).not.toHaveProperty('remoteWorkspaceSyncGracePeriodSeconds')
    }

    store.flush()
    const persisted = readDataFile() as { sshTargets?: Record<string, unknown>[] }
    expect(persisted.sshTargets?.[0]).not.toHaveProperty('relayGracePeriodSeconds')
    expect(persisted.sshTargets?.[1]?.relayGracePeriodSeconds).toBe(0)
    expect(persisted.sshTargets?.[2]?.relayGracePeriodSeconds).toBe(0)
    expect(persisted.sshTargets?.[3]?.relayGracePeriodSeconds).toBe(0)
    for (const target of persisted.sshTargets ?? []) {
      expect(target).not.toHaveProperty('remoteWorkspaceSyncEnabled')
      expect(target).not.toHaveProperty('remoteWorkspaceSyncGracePeriodSeconds')
    }
  })

  it('persists the SSH target source field through add, update, and disk round-trip', async () => {
    const store = await createStore()
    store.addSshTarget({
      id: 'ssh-src-1',
      label: 'cluster',
      configHost: 'cluster',
      host: '10.0.0.5',
      port: 2200,
      username: 'dev',
      source: 'ssh-config'
    })

    // normalizeSshTarget must not strip `source` on update, and the new port
    // must take effect — this is the persistence-layer guard for #4684 item #1.
    const updated = store.updateSshTarget('ssh-src-1', { port: 2222, source: 'ssh-config' })
    expect(updated?.port).toBe(2222)
    expect(updated?.source).toBe('ssh-config')

    expect(store.getSshTarget('ssh-src-1')?.source).toBe('ssh-config')
    expect(store.getSshTarget('ssh-src-1')?.port).toBe(2222)

    store.flush()
    const persisted = readDataFile() as { sshTargets?: Record<string, unknown>[] }
    const onDisk = persisted.sshTargets?.find((t) => t.id === 'ssh-src-1')
    expect(onDisk?.source).toBe('ssh-config')
    expect(onDisk?.port).toBe(2222)
  })

  it('upserts ~/.ssh/config through the real store: rotated port updates in place and persists', async () => {
    loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
    const candidate = (port: number, id: string) => [
      { id, label: 'cluster', configHost: 'cluster', host: '10.0.0.5', port, username: 'dev' }
    ]

    const store = await createStore()
    const sshStore = new SshConnectionStore(store)

    // First sync inserts the config host, stamped as config-managed.
    sshConfigHostsToTargetsMock.mockReturnValue(candidate(2200, 'ssh-cfg-1'))
    const inserted = sshStore.importFromSshConfig()
    expect(inserted).toHaveLength(1)
    expect(inserted[0]?.source).toBe('ssh-config')
    expect(inserted[0]?.port).toBe(2200)

    // Rotated port: the upsert must update the SAME target in place — and the
    // real normalizeSshTarget must keep `source` and not falsely re-derive
    // configHost into a permanently-dirty state.
    sshConfigHostsToTargetsMock.mockReturnValue(candidate(2222, 'ssh-cfg-2'))
    const changed = sshStore.importFromSshConfig()
    expect(changed).toHaveLength(1)
    expect(changed[0]?.port).toBe(2222)
    expect(changed[0]?.source).toBe('ssh-config')

    // A third identical sync is a no-op (dirty-check against the real persisted
    // fields) — proving repeated auto-sync on every pane open writes nothing.
    expect(sshStore.importFromSshConfig()).toHaveLength(0)

    // Exactly one cluster target on disk with the rotated port and source kept.
    store.flush()
    const onDisk = (readDataFile() as { sshTargets?: Record<string, unknown>[] }).sshTargets
    const clusterTargets = (onDisk ?? []).filter((t) => t.configHost === 'cluster')
    expect(clusterTargets).toHaveLength(1)
    expect(clusterTargets[0]?.port).toBe(2222)
    expect(clusterTargets[0]?.source).toBe('ssh-config')

    // Survives a fresh load from the same data file.
    const reloaded = await createStore()
    const reloadedCluster = reloaded.getSshTargets().find((t) => t.configHost === 'cluster')
    expect(reloadedCluster?.port).toBe(2222)
    expect(reloadedCluster?.source).toBe('ssh-config')
  })

  it('drops malformed migration-unsupported PTY entries on load', async () => {
    const repo = makeRepo()
    writeDataFile({
      schemaVersion: 1,
      repos: [repo],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      migrationUnsupportedPtyEntries: {}
    })

    const store = await createStore()

    expect(store.getRepos()).toHaveLength(1)
  })

  it('remaps persisted agent acknowledgement pane keys when terminal leaves migrate to UUIDs', async () => {
    const acknowledgedAt = 1_700_000_000_000
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo()],
      worktreeMeta: {},
      settings: {},
      ui: {
        acknowledgedAgentsByPaneKey: {
          'tab1:0': acknowledgedAt,
          'tab1:pane:1': acknowledgedAt - 1_000,
          'other-tab:0': acknowledgedAt - 2_000
        }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'repo1::/worktree',
        activeTabId: 'tab1',
        tabsByWorktree: {
          'repo1::/worktree': [
            makeTerminalTab({
              id: 'tab1',
              ptyId: 'pty1',
              worktreeId: 'repo1::/worktree'
            })
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: '0' },
              second: { type: 'leaf', leafId: 'pane:1' }
            },
            activeLeafId: '0',
            expandedLeafId: null,
            ptyIdsByLeafId: { '0': 'pty1', 'pane:1': 'pty2' }
          }
        }
      }
    })

    const store = await createStore()
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    const migratedLeafIds = Object.keys(layout.ptyIdsByLeafId ?? {})

    expect(migratedLeafIds).toHaveLength(2)
    expect(migratedLeafIds.every(isTerminalLeafId)).toBe(true)

    const ui = store.getUI()
    expect(ui.acknowledgedAgentsByPaneKey).toEqual({
      [makePaneKey('tab1', migratedLeafIds[0])]: acknowledgedAt,
      [makePaneKey('tab1', migratedLeafIds[1])]: acknowledgedAt - 1_000,
      'other-tab:0': acknowledgedAt - 2_000
    })
  })

  it('keeps the newest acknowledgement when legacy and migrated pane keys collide', async () => {
    const legacyAcknowledgedAt = 1_700_000_000_000
    const migratedAcknowledgedAt = legacyAcknowledgedAt + 5_000
    const migratedPaneKey = makePaneKey('tab1', TEST_LEAF_1)

    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo()],
      worktreeMeta: {},
      settings: {},
      ui: {
        acknowledgedAgentsByPaneKey: {
          'tab1:0': legacyAcknowledgedAt,
          [migratedPaneKey]: migratedAcknowledgedAt
        }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'repo1::/worktree',
        activeTabId: 'tab1',
        tabsByWorktree: {
          'repo1::/worktree': [
            makeTerminalTab({
              id: 'tab1',
              ptyId: 'pty1',
              worktreeId: 'repo1::/worktree'
            })
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: TEST_LEAF_1 },
            activeLeafId: TEST_LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty1' }
          }
        }
      }
    })

    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'repo1::/worktree',
      activeTabId: 'tab1',
      tabsByWorktree: {
        'repo1::/worktree': [
          makeTerminalTab({
            id: 'tab1',
            ptyId: 'pty1',
            worktreeId: 'repo1::/worktree'
          })
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: '0' },
          activeLeafId: '0',
          expandedLeafId: null,
          ptyIdsByLeafId: { '0': 'pty1' }
        }
      }
    })

    expect(store.getUI().acknowledgedAgentsByPaneKey).toEqual({
      [migratedPaneKey]: migratedAcknowledgedAt
    })
  })

  it('can clear an automation back to the project default branch', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ worktreeBaseRef: 'origin/main' }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      baseBranch: 'origin/release',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const updated = store.updateAutomation(automation.id, { baseBranch: null })

    expect(updated.baseBranch).toBeNull()
    store.flush()
    const persisted = readDataFile() as { automations: { baseBranch: string | null }[] }
    expect(persisted.automations[0].baseBranch).toBeNull()
  })

  it('persists session reuse only for existing-workspace automations', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const existingWorkspace = store.createAutomation({
      name: 'Digest',
      prompt: 'Summarize changes',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const newPerRun = store.createAutomation({
      name: 'Fresh',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(existingWorkspace.reuseSession).toBe(true)
    expect(newPerRun.reuseSession).toBe(false)
    expect(
      store.updateAutomation(existingWorkspace.id, { workspaceMode: 'new_per_run' }).reuseSession
    ).toBe(false)

    const persisted = readDataFile() as { automations: Record<string, unknown>[] }
    delete persisted.automations[0].reuseSession
    writeDataFile(persisted)
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].reuseSession).toBe(false)
  })

  it('derives automation source and run contexts from the project host setup', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        upstream: { owner: 'stablyai', repo: 'orca' },
        connectionId: 'builder'
      })
    )

    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.runContext).toMatchObject({
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      path: '/repo'
    })
    expect(automation.sourceContext).toMatchObject({
      kind: 'task-source',
      provider: 'github',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
  })

  it('marks runtime-owned automations as remote-host scheduled', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        executionHostId: toRuntimeExecutionHostId('gpu-server'),
        upstream: { owner: 'stablyai', repo: 'orca' }
      })
    )

    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.schedulerOwner).toBe('remote_host_service')
    expect(automation.runContext).toMatchObject({
      hostId: toRuntimeExecutionHostId('gpu-server')
    })
  })

  it('snapshots automation contexts onto runs', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    store.updateAutomation(automation.id, { sourceContext: null, runContext: null })

    expect(run.runContext).toEqual(automation.runContext)
    expect(run.sourceContext).toEqual(automation.sourceContext)
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      runContext: automation.runContext,
      sourceContext: automation.sourceContext
    })
  })

  it('backfills legacy automation contexts on load', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        upstream: { owner: 'stablyai', repo: 'orca' },
        connectionId: 'builder'
      })
    )
    const automation = store.createAutomation({
      name: 'Legacy nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const persisted = readDataFile() as {
      automations: Record<string, unknown>[]
      automationRuns: Record<string, unknown>[]
    }
    delete persisted.automations[0].runContext
    delete persisted.automations[0].sourceContext
    delete persisted.automationRuns[0].runContext
    delete persisted.automationRuns[0].sourceContext
    writeDataFile(persisted)

    const reloaded = await createStore()
    const migratedAutomation = reloaded
      .listAutomations()
      .find((entry) => entry.id === automation.id)
    const migratedRun = reloaded
      .listAutomationRuns(automation.id)
      .find((entry) => entry.id === run.id)

    expect(migratedAutomation?.runContext).toMatchObject({
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      path: '/repo'
    })
    expect(migratedAutomation?.sourceContext).toMatchObject({
      kind: 'task-source',
      provider: 'github',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
    expect(migratedRun?.runContext).toEqual(migratedAutomation?.runContext)
    expect(migratedRun?.sourceContext).toEqual(migratedAutomation?.sourceContext)
  })

  it('persists automation precheck config and run results', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Conditional',
      prompt: 'Run checks',
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())

    store.updateAutomationRun({
      runId: run.id,
      status: 'skipped_precheck',
      precheckResult: {
        command: 'test -f ready',
        exitCode: 1,
        timedOut: false,
        durationMs: 12,
        stdout: '',
        stderr: 'missing',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
        startedAt: 10,
        completedAt: 22
      },
      error: 'Precheck exited with code 1.'
    })

    expect(store.listAutomations()[0].precheck).toEqual({
      command: 'test -f ready',
      timeoutSeconds: 30
    })
    expect(store.listAutomationRuns(automation.id)[0].precheckResult).toMatchObject({
      exitCode: 1,
      stderr: 'missing'
    })
    expect(store.updateAutomation(automation.id, { precheck: null }).precheck).toBeNull()
  })

  it('numbers automation run titles per automation', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const first = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const duplicate = store.createAutomationRun(
      automation,
      new Date('2026-05-13T09:00:00Z').getTime()
    )
    const second = store.createAutomationRun(automation, new Date('2026-05-14T09:00:00Z').getTime())

    expect(first.title).toBe('Nightly run 1')
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.title).toBe('Nightly run 1')
    expect(second.title).toBe('Nightly run 2')
  })

  it('records feature interactions when automations are created or manually queued', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime(), 'scheduled')
    store.createAutomationRun(automation, new Date('2026-05-14T09:00:00Z').getTime(), 'manual')

    expect(store.getUI().featureInteractions?.['automation-created']?.interactionCount).toBe(1)
    expect(store.getUI().featureInteractions?.['automation-run']?.interactionCount).toBe(1)
    const persisted = readDataFile() as PersistedState
    expect(persisted.ui?.featureInteractions?.['automation-created']).toMatchObject({
      interactionCount: 1
    })
    expect(persisted.ui?.featureInteractions?.['automation-run']).toMatchObject({
      interactionCount: 1
    })
  })

  it('snapshots automation run workspace names for deleted-workspace history', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    store.setWorktreeMeta('wt1', { displayName: 'Nightly workspace' })
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    store.removeWorktreeMeta('wt1')

    expect(run.workspaceDisplayName).toBe('Nightly workspace')
    expect(store.listAutomationRuns(automation.id)[0].workspaceDisplayName).toBe(
      'Nightly workspace'
    )
  })

  it('backfills automation run workspace names before workspace deletion', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())

    const updatedCount = store.snapshotAutomationRunWorkspaceDisplayName('wt1', 'Deleted workspace')

    expect(updatedCount).toBe(1)
    expect(store.listAutomationRuns(automation.id)[0].workspaceDisplayName).toBe(
      'Deleted workspace'
    )
  })

  it('persists automation run output snapshots across later status updates', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())

    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Run finished',
        capturedAt: 1,
        truncated: false
      },
      error: null
    })
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      usage: null,
      error: null
    })

    expect(store.listAutomationRuns(automation.id)[0].outputSnapshot).toMatchObject({
      content: 'Run finished',
      truncated: false
    })
  })

  // ── 3. Corrupt JSON → falls back to defaults ────────────────────────

  it('falls back to defaults when data file contains invalid JSON', async () => {
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{{invalid json', 'utf-8')

    const store = await createStore()
    expect(store.getRepos()).toEqual([])
    expect(store.getSettings().theme).toBe('system')
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
      commandInputTemplate: '{basePrompt}\n\nRollback commit prompt'
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

  it('migrates the legacy floating terminal disabled default to enabled', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { floatingTerminalEnabled: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().floatingTerminalEnabled).toBe(true)
    expect(store.getSettings().floatingTerminalDefaultedForAllUsers).toBe(true)
  })

  it('preserves a post-migration floating terminal opt-out', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalEnabled: false,
        floatingTerminalDefaultedForAllUsers: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().floatingTerminalEnabled).toBe(false)
    expect(store.getSettings().floatingTerminalDefaultedForAllUsers).toBe(true)
  })

  it('migrates the legacy Linux primary-selection default to enabled', async () => {
    await withPlatform('linux', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { primarySelectionMiddleClickPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForLinux).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('preserves a post-migration Linux primary-selection opt-out', async () => {
    await withPlatform('linux', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: {
          primarySelectionMiddleClickPaste: false,
          primarySelectionMiddleClickPasteDefaultedForLinux: true
        },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForLinux).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('migrates the legacy macOS primary-selection default to enabled', async () => {
    await withPlatform('darwin', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { primarySelectionMiddleClickPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(true)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForLinux).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('preserves a post-migration macOS primary-selection opt-out', async () => {
    await withPlatform('darwin', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: {
          primarySelectionMiddleClickPaste: false,
          primarySelectionMiddleClickPasteDefaultedForTerminalDefaults: true
        },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        true
      )
    })
  })

  it('keeps the primary-selection default disabled on Windows profiles', async () => {
    await withPlatform('win32', async () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { primarySelectionMiddleClickPaste: false },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getSettings().primarySelectionMiddleClickPaste).toBe(false)
      expect(store.getSettings().primarySelectionMiddleClickPasteDefaultedForTerminalDefaults).toBe(
        false
      )
    })
  })

  it('seeds trusted floating workspace directories from legacy explicit cwd values', async () => {
    const legacyFloatingCwd = join(testState.dir, 'legacy-floating-cwd')
    mkdirSync(legacyFloatingCwd)
    const canonicalLegacyFloatingCwd = realpathSync(legacyFloatingCwd)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: legacyFloatingCwd
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe(legacyFloatingCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([canonicalLegacyFloatingCwd])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([canonicalLegacyFloatingCwd])
  })

  it('persists the floating cwd migration marker when a legacy explicit cwd is unavailable', async () => {
    const unavailableLegacyFloatingCwd = join(testState.dir, 'missing-floating-cwd')
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: unavailableLegacyFloatingCwd
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe(unavailableLegacyFloatingCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalCwdMigratedToAppWorkspace?: boolean } })
        .settings?.floatingTerminalCwdMigratedToAppWorkspace
    ).toBe(true)
  })

  it('does not seed trusted floating workspace directories after the cwd migration has run', async () => {
    const postMigrationCwd = join(testState.dir, 'post-migration-cwd')
    mkdirSync(postMigrationCwd)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: postMigrationCwd,
        floatingTerminalCwdMigratedToAppWorkspace: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe(postMigrationCwd)
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
  })

  it('restores migrated blank floating terminal cwd settings to home shorthand', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: '',
        floatingTerminalCwdMigratedToAppWorkspace: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe('~')
  })

  it('preserves legacy home shorthand as the floating terminal cwd', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalCwd: '~'
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalCwd).toBe('~')
    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
  })

  it('canonicalizes persisted floating workspace trust paths on load', async () => {
    const trustedTarget = join(testState.dir, 'trusted-target')
    const trustedLink = join(testState.dir, 'trusted-link')
    mkdirSync(trustedTarget)
    symlinkDirectorySync(trustedTarget, trustedLink)
    const canonicalTrustedTarget = realpathSync(trustedTarget)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalTrustedCwds: [trustedLink]
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([canonicalTrustedTarget])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([canonicalTrustedTarget])
  })

  it('preserves temporarily unavailable floating workspace trust paths on load', async () => {
    const unavailableTrustedPath = join(testState.dir, 'offline-drive', 'notes')
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalTrustedCwds: [unavailableTrustedPath]
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([unavailableTrustedPath])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([unavailableTrustedPath])
  })

  it('drops blank floating workspace trust paths on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalTrustedCwds: ['', '   ']
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().floatingTerminalTrustedCwds).toEqual([])
    store.flush()
    expect(
      (readDataFile() as { settings?: { floatingTerminalTrustedCwds?: string[] } }).settings
        ?.floatingTerminalTrustedCwds
    ).toEqual([])
  })

  it('preserves custom notification sound paths from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg'
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications).toMatchObject({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      suppressWhenFocused: true,
      customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg',
      customSoundVolume: 100
    })
  })

  it('clamps notification custom sound volume from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundVolume: 250
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications.customSoundVolume).toBe(100)
  })

  it('defaults invalid notification custom sound volume from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundVolume: Number.NaN
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications.customSoundVolume).toBe(100)
  })

  it('preserves editorAutoSaveDelayMs when set in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { editorAutoSaveDelayMs: 2500 },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().editorAutoSaveDelayMs).toBe(2500)
  })

  it('preserves editorAutoSave when set to true in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { editorAutoSave: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().editorAutoSave).toBe(true)
  })

  it('keeps legacy rightSidebarOpenByDefault readable from persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { rightSidebarOpenByDefault: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
  })

  it('preserves terminalUseSeparateLightTheme when persisted as false', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalUseSeparateLightTheme: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().terminalUseSeparateLightTheme).toBe(false)
  })

  // ── 5. addRepo and getRepo ──────────────────────────────────────────

  it('addRepo stores a repo retrievable by getRepo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const fetched = store.getRepo('r1')
    expect(fetched).toBeDefined()
    expect(fetched!.displayName).toBe('test')
    expect(fetched!.gitUsername).toBe('testuser')
  })

  it('deleteProjectGroup ungroups repos from the deleted group subtree', async () => {
    const store = await createStore()
    const root = store.createProjectGroup({ name: 'Platform', createdFrom: 'folder-scan' })
    const child = store.createProjectGroup({
      name: 'Services',
      parentGroupId: root.id,
      createdFrom: 'folder-scan'
    })
    const sibling = store.createProjectGroup({ name: 'Tools', createdFrom: 'manual' })
    store.addRepo(makeRepo({ id: 'direct', path: '/direct', projectGroupId: root.id }))
    store.addRepo(makeRepo({ id: 'nested', path: '/nested', projectGroupId: child.id }))
    store.addRepo(makeRepo({ id: 'sibling', path: '/sibling', projectGroupId: sibling.id }))

    expect(store.deleteProjectGroup(root.id)).toBe(true)

    expect(store.getProjectGroups().map((group) => group.id)).toEqual([sibling.id])
    expect(store.getRepo('direct')?.projectGroupId).toBeNull()
    expect(store.getRepo('nested')?.projectGroupId).toBeNull()
    expect(store.getRepo('sibling')?.projectGroupId).toBe(sibling.id)
  })

  it('adapts flat folder-scan groups into sparse nested folder scopes on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({ id: 'api', path: '/workspace/platform/api', projectGroupId: 'root' }),
        makeRepo({ id: 'web', path: '/workspace/platform/web', projectGroupId: 'root' }),
        makeRepo({
          id: 'repo1',
          path: '/workspace/platform/packages/shared/repo1',
          projectGroupId: 'root'
        }),
        makeRepo({
          id: 'repo2',
          path: '/workspace/platform/packages/shared/repo2',
          projectGroupId: 'root'
        })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    const groups = store.getProjectGroups()
    const shared = groups.find((group) => group.name === 'packages/shared')

    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, '/workspace/platform'],
      ['packages/shared', 'root', '/workspace/platform/packages/shared']
    ])
    expect(store.getRepo('api')?.projectGroupId).toBe('root')
    expect(store.getRepo('web')?.projectGroupId).toBe('root')
    expect(store.getRepo('repo1')?.projectGroupId).toBe(shared?.id)
    expect(store.getRepo('repo2')?.projectGroupId).toBe(shared?.id)
  })

  it('creates a project group when persisted group history is very large', async () => {
    const projectGroups: ProjectGroup[] = Array.from({ length: 130_000 }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index}`,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: index,
      isCollapsed: false,
      color: null,
      createdAt: index,
      updatedAt: index
    }))
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups
    })
    const store = await createStore()

    const group = store.createProjectGroup({ name: 'New group', createdFrom: 'manual' })

    expect(group.tabOrder).toBe(projectGroups.length)
  })

  it('sanitizes invalid project group updates before persisting a repo', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
    store.addRepo(makeRepo({ id: 'r1', projectGroupId: group.id, projectGroupOrder: 1 }))

    const updated = store.updateRepo('r1', {
      projectGroupId: '',
      projectGroupOrder: Number.POSITIVE_INFINITY
    } as never)

    expect(updated?.projectGroupId).toBeNull()
    expect(updated?.projectGroupOrder).toBe(1)
  })

  it('getRepo returns undefined for nonexistent id', async () => {
    const store = await createStore()
    expect(store.getRepo('nonexistent')).toBeUndefined()
  })

  // ── 6. removeProject cleans up worktree meta ──────────────────────────

  it('removeProject deletes the repo and its worktree meta', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })
    store.setWorktreeMeta('r1::/path/wt2', { displayName: 'wt2' })
    store.setWorktreeMeta('r2::/other', { displayName: 'other' })

    store.removeProject('r1')

    expect(store.getRepo('r1')).toBeUndefined()
    expect(store.getWorktreeMeta('r1::/path/wt1')).toBeUndefined()
    expect(store.getWorktreeMeta('r1::/path/wt2')).toBeUndefined()
    expect(store.getWorktreeMeta('r2::/other')).toBeDefined()
    expect(store.getWorktreeMeta('r2::/other')!.displayName).toBe('other')
  })

  it('removeProject removes the derived project host setup compatibility record', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.removeProject('r1')

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r2'])
    expect(store.getProjectHostSetups().map((setup) => setup.id)).toEqual(['r2'])
  })

  it('removeProject deletes child and parent lineage for the repo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.setWorktreeLineage(
      'r1::/path/child',
      makeWorktreeLineage({
        worktreeId: 'r1::/path/child',
        parentWorktreeId: 'r1::/path/parent'
      })
    )
    store.setWorktreeLineage(
      'r2::/other-child',
      makeWorktreeLineage({
        worktreeId: 'r2::/other-child',
        parentWorktreeId: 'r1::/path/parent'
      })
    )
    store.setWorktreeLineage(
      'r2::/other',
      makeWorktreeLineage({
        worktreeId: 'r2::/other',
        parentWorktreeId: 'r2::/parent'
      })
    )

    store.removeProject('r1')

    expect(store.getWorktreeLineage('r1::/path/child')).toBeUndefined()
    expect(store.getWorktreeLineage('r2::/other-child')).toBeUndefined()
    expect(store.getWorktreeLineage('r2::/other')).toBeDefined()
  })

  // ── 7. updateRepo ──────────────────────────────────────────────────

  it('updateRepo modifies the repo in place', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { displayName: 'renamed' })
    expect(updated).not.toBeNull()
    expect(updated!.displayName).toBe('renamed')
    expect(store.getRepo('r1')!.displayName).toBe('renamed')
  })

  it('updateRepo keeps project host setup compatibility records in sync', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ worktreeBasePath: '../worktrees' }))

    store.updateRepo('r1', {
      displayName: 'renamed',
      worktreeBasePath: '../new-worktrees',
      upstream: { owner: 'stablyai', repo: 'orca' }
    })

    expect(store.getProjects()).toEqual([
      expect.objectContaining({
        id: 'github:stablyai/orca',
        displayName: 'renamed',
        sourceRepoIds: ['r1']
      })
    ])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({
        id: 'r1',
        projectId: 'github:stablyai/orca',
        displayName: 'renamed',
        worktreeBasePath: '../new-worktrees'
      })
    ])
  })

  it('repo mutations preserve independent project host setup records', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ id: 'r1' })],
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })
    const store = await createStore()

    store.updateRepo('r1', { displayName: 'renamed' })
    store.reorderRepos(['r1'])

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r1', 'cloud-project'])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({ id: 'r1', displayName: 'renamed' }),
      independentSetup
    ])
  })

  it('updates independent project host setup records directly', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })
    const store = await createStore()

    const result = store.updateProjectHostSetup({
      setupId: independentSetup.id,
      updates: {
        displayName: 'GPU VM renamed',
        path: '/srv/renamed',
        worktreeBasePath: '../worktrees',
        setupState: 'ready',
        setupMethod: 'cloned',
        gitUsername: 'alice'
      }
    })

    expect(result).toEqual({
      project: independentProject,
      setup: expect.objectContaining({
        id: independentSetup.id,
        displayName: 'GPU VM renamed',
        path: '/srv/renamed',
        worktreeBasePath: '../worktrees',
        setupState: 'ready',
        setupMethod: 'cloned',
        gitUsername: 'alice'
      })
    })
    expect(store.getProjectHostSetups()[0]).toMatchObject({
      displayName: 'GPU VM renamed',
      path: '/srv/renamed'
    })
  })

  it('creates independent project host setup records for provisioning flows', async () => {
    const store = await createStore()
    store.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })

    const result = store.createProjectHostSetup({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm',
      setupId: 'cloud-project::gpu-vm',
      displayName: 'GPU VM',
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })

    expect(result?.project).toMatchObject({
      id: 'github:stablyai/cloud-project',
      displayName: 'Cloud Project'
    })
    expect(result?.setup).toMatchObject({
      id: 'cloud-project::gpu-vm',
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '',
      displayName: 'GPU VM',
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })
    expect(store.getRepos()).toHaveLength(1)
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({ id: 'r1', repoId: 'r1' }),
      result?.setup
    ])
  })

  it('rejects duplicate project host setup creation for the same host', async () => {
    const store = await createStore()
    store.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm'
    })
    store.createProjectHostSetup({
      projectId: independentSetup.projectId,
      hostId: independentSetup.hostId,
      setupId: independentSetup.id
    })

    expect(() =>
      store.createProjectHostSetup({
        projectId: 'github:stablyai/cloud-project',
        hostId: 'runtime:gpu-vm',
        setupId: 'duplicate'
      })
    ).toThrow('Project host setup already exists: cloud-project::gpu-vm')
  })

  it('updates repo-backed project host setup metadata through the repo record', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', displayName: 'Repo', worktreeBasePath: '../old' }))

    const result = store.updateProjectHostSetup({
      setupId: 'r1',
      updates: {
        displayName: 'Repo renamed',
        worktreeBasePath: '../new',
        setupMethod: 'cloned'
      }
    })

    expect(result?.repo).toMatchObject({
      id: 'r1',
      displayName: 'Repo renamed',
      worktreeBasePath: '../new',
      projectHostSetupMethod: 'cloned'
    })
    expect(result?.project).toMatchObject({
      id: 'repo:r1',
      displayName: 'Repo renamed'
    })
    expect(result?.setup).toMatchObject({
      id: 'r1',
      displayName: 'Repo renamed',
      worktreeBasePath: '../new',
      setupMethod: 'cloned'
    })
  })

  it('rejects repo-backed project host setup path changes', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))

    expect(() =>
      store.updateProjectHostSetup({
        setupId: 'r1',
        updates: { path: '/other' }
      })
    ).toThrow('Repo-backed project host setup paths must be changed by re-importing the project.')
  })

  it('deletes independent project host setup records without deleting the project', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })
    const store = await createStore()

    const result = store.deleteProjectHostSetup({ setupId: independentSetup.id })

    expect(result).toEqual({ project: independentProject, setup: independentSetup })
    expect(store.getProjects()).toEqual([independentProject])
    expect(store.getProjectHostSetups()).toEqual([])
  })

  it('deletes repo-backed project host setups by removing the compatibility repo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))
    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })

    const result = store.deleteProjectHostSetup({ setupId: 'r1' })

    expect(result?.project).toMatchObject({ id: 'repo:r1' })
    expect(result?.setup).toMatchObject({ id: 'r1', repoId: 'r1' })
    expect(result?.repo).toMatchObject({ id: 'r1' })
    expect(store.getRepo('r1')).toBeUndefined()
    expect(store.getProjects()).toEqual([])
    expect(store.getProjectHostSetups()).toEqual([])
    expect(store.getWorktreeMeta('r1::/path/wt1')).toBeUndefined()
  })

  it('updateRepo preserves repo-backed project host setup method', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    store.updateRepo('r1', { projectHostSetupMethod: 'cloned' })

    expect(store.getRepo('r1')?.projectHostSetupMethod).toBe('cloned')
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({
        id: 'r1',
        setupMethod: 'cloned'
      })
    ])
  })

  it('updateRepo drops repo icons that fail shared sanitization', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      repoIcon: {
        type: 'image',
        source: 'upload',
        src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
      } as never
    })

    expect(updated).not.toBeNull()
    expect(updated!.repoIcon).toBeUndefined()
    expect(store.getRepo('r1')!.repoIcon).toBeUndefined()
  })

  it('updateRepo normalizes custom repo badge colors before storing', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { badgeColor: ' ABCDEF ' })

    expect(updated!.badgeColor).toBe('#abcdef')
    expect(store.getRepo('r1')!.badgeColor).toBe('#abcdef')
  })

  it('updateRepo ignores invalid repo badge colors without clearing the existing color', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ badgeColor: '#123456' }))

    const updated = store.updateRepo('r1', { badgeColor: 'blue' })

    expect(updated!.badgeColor).toBe('#123456')
    expect(store.getRepo('r1')!.badgeColor).toBe('#123456')
  })

  it('getRepo does not expose invalid persisted repo icons', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        repoIcon: {
          type: 'image',
          source: 'upload',
          src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
        } as never
      })
    )

    expect(store.getRepo('r1')!.repoIcon).toBeUndefined()
    expect(store.getRepos()[0]!.repoIcon).toBeUndefined()
  })

  it('updateRepo normalizes and persists repo upstream metadata', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      upstream: { owner: ' stablyai ', repo: ' orca ' }
    })
    expect(updated!.upstream).toEqual({ owner: 'stablyai', repo: 'orca' })

    store.updateRepo('r1', { upstream: null })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.upstream).toBeNull()
  })

  it('getRepo does not expose invalid persisted repo upstream metadata', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: '', repo: 42 } as never }))

    expect(store.getRepo('r1')!.upstream).toBeUndefined()
    expect(store.getRepos()[0]!.upstream).toBeUndefined()
  })

  it('updateRepo returns null for nonexistent id', async () => {
    const store = await createStore()
    expect(store.updateRepo('nope', { displayName: 'x' })).toBeNull()
  })

  it('updateRepo persists issueSourcePreference across reloads', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { issueSourcePreference: 'upstream' })
    expect(updated!.issueSourcePreference).toBe('upstream')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBe('upstream')
  })

  it('updateRepo persists fork sync mode across reloads', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { forkSyncMode: 'safe-auto' })
    expect(updated!.forkSyncMode).toBe('safe-auto')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.forkSyncMode).toBe('safe-auto')
  })

  it('updateRepo ignores invalid fork sync mode updates', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ forkSyncMode: 'ask' }))

    const updated = store.updateRepo('r1', { forkSyncMode: 'always' as never })

    expect(updated!.forkSyncMode).toBe('ask')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.forkSyncMode).toBe('ask')
  })

  it('getRepo does not expose invalid persisted fork sync mode values', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ forkSyncMode: 'always' as never })]
    })

    const store = await createStore()

    expect(store.getRepo('r1')!.forkSyncMode).toBeUndefined()
    expect(store.getRepos()[0]!.forkSyncMode).toBeUndefined()
  })

  it('updateRepo with issueSourcePreference=undefined clears the preference', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ issueSourcePreference: 'origin' }))
    expect(store.getRepo('r1')!.issueSourcePreference).toBe('origin')

    // Why: passing the key with value `undefined` must clear the preference.
    // Plain `Object.assign` skips undefined values, so without the explicit
    // delete branch in updateRepo, the persisted record would keep 'origin'.
    store.updateRepo('r1', { issueSourcePreference: undefined })
    expect(store.getRepo('r1')!.issueSourcePreference).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBeUndefined()
  })

  it('updateRepo stamps legacy external-worktree visibility before changing old repos', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        addedAt: Date.UTC(2026, 4, 24),
        externalWorktreeVisibility: undefined,
        externalWorktreeVisibilityLegacy: undefined
      })
    )

    const updated = store.updateRepo('r1', { externalWorktreeVisibility: 'hide' })

    expect(updated!.externalWorktreeVisibility).toBe('hide')
    expect(updated!.externalWorktreeVisibilityLegacy).toBe(true)
  })

  it('updateRepo clears source-control AI overrides independently from other clearable fields', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        issueSourcePreference: 'origin',
        sourceControlAi: {
          instructionsByOperation: { commitMessage: 'Repo style' },
          prCreationDefaults: { draft: true }
        }
      })
    )

    store.updateRepo('r1', {
      issueSourcePreference: undefined,
      sourceControlAi: undefined
    })

    expect(store.getRepo('r1')!.issueSourcePreference).toBeUndefined()
    expect(store.getRepo('r1')!.sourceControlAi).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBeUndefined()
    expect(reloaded.getRepo('r1')!.sourceControlAi).toBeUndefined()
  })

  it('updateRepo treats source-control AI null as a transport clear sentinel', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        sourceControlAi: {
          enabled: true,
          customAgentCommand: 'repo-agent {prompt}'
        }
      })
    )

    store.updateRepo('r1', {
      sourceControlAi: null
    })

    expect(store.getRepo('r1')!.sourceControlAi).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.sourceControlAi).toBeUndefined()
  })

  it('updateRepo normalizes source-control AI overrides before storing', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      sourceControlAi: {
        instructionsByOperation: {
          commitMessage: 'Repo style',
          pullRequest: 42,
          unknown: 'ignored'
        },
        prCreationDefaults: {
          draft: true,
          useTemplate: null,
          openAfterCreate: 'yes'
        },
        modelOverridesByOperation: {
          commitMessage: {
            selectedModelByAgent: { codex: 'gpt-5.4', claude: false },
            selectedThinkingByModel: { 'gpt-5.4': 'high', bad: true }
          },
          unknown: {
            selectedModelByAgent: { codex: 'ignored' }
          }
        }
      } as never
    })

    expect(updated!.sourceControlAi).toEqual({
      instructionsByOperation: {
        commitMessage: 'Repo style'
      },
      actionOverrides: {
        commitMessage: {
          commandInputTemplate: '{basePrompt}\n\nRepo style'
        }
      },
      prCreationDefaults: {
        draft: true,
        useTemplate: null
      },
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedThinkingByModel: { 'gpt-5.4': 'high' }
        }
      }
    })
  })

  it('updateRepo ignores malformed source-control AI overrides without clearing existing overrides', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        sourceControlAi: {
          instructionsByOperation: { commitMessage: 'Keep me' }
        }
      })
    )

    const updated = store.updateRepo('r1', { sourceControlAi: 'bad' as never })

    expect(updated!.sourceControlAi).toEqual({
      instructionsByOperation: { commitMessage: 'Keep me' },
      actionOverrides: {
        commitMessage: {
          commandInputTemplate: '{basePrompt}\n\nKeep me'
        }
      }
    })
  })

  // ── 8. setWorktreeMeta and getWorktreeMeta ─────────────────────────

  it('setWorktreeMeta creates meta with defaults for missing fields', async () => {
    const store = await createStore()
    const meta = store.setWorktreeMeta('wt1', { displayName: 'my-wt' })

    expect(meta.displayName).toBe('my-wt')
    expect(meta.comment).toBe('')
    expect(meta.linkedIssue).toBeNull()
    expect(meta.isArchived).toBe(false)
    expect(typeof meta.sortOrder).toBe('number')
  })

  it('setWorktreeMeta merges with existing meta', async () => {
    const store = await createStore()
    store.setWorktreeMeta('wt1', { displayName: 'first', comment: 'hello' })
    const updated = store.setWorktreeMeta('wt1', { comment: 'updated' })

    expect(updated.displayName).toBe('first')
    expect(updated.comment).toBe('updated')
  })

  it('creates and updates folder workspaces from folder-backed project groups', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const linkedTask = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      title: 'Refund fix',
      url: 'https://linear.app/acme/issue/ENG-123',
      linearIdentifier: 'ENG-123'
    }

    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Refund fix',
      linkedTask
    })
    const updated = store.updateFolderWorkspace(workspace.id, {
      comment: 'Coordinate api and web',
      isPinned: true,
      lastActivityAt: 123
    })

    expect(workspace.folderPath).toBe('/workspace/platform')
    expect(updated).toMatchObject({
      id: workspace.id,
      projectGroupId: group.id,
      name: 'Refund fix',
      folderPath: '/workspace/platform',
      linkedTask,
      comment: 'Coordinate api and web',
      isPinned: true,
      lastActivityAt: 123
    })
    expect(store.getFolderWorkspaces()).toHaveLength(1)
  })

  it('rejects folder workspace creation for non-folder-backed project groups', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Manual', createdFrom: 'manual' })

    expect(() => store.createFolderWorkspace({ projectGroupId: group.id })).toThrow(
      'Folder-backed project group not found.'
    )
  })

  it('normalizes persisted folder workspaces and drops orphaned records', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'root',
          name: '  ',
          folderPath: '',
          comment: 42,
          isArchived: true,
          isUnread: true,
          isPinned: false,
          sortOrder: 10,
          lastActivityAt: 5,
          createdAt: 2,
          updatedAt: 3
        },
        {
          id: 'orphan',
          projectGroupId: 'missing',
          name: 'Orphan',
          folderPath: '/missing'
        }
      ]
    })

    const store = await createStore()

    expect(store.getFolderWorkspaces()).toEqual([
      expect.objectContaining({
        id: 'fw-1',
        projectGroupId: 'root',
        name: 'Untitled workspace',
        folderPath: '/workspace/platform',
        comment: '',
        isArchived: true,
        isUnread: true
      })
    ])
  })

  it('backfills folder-scope SSH provenance from unambiguous child repos on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'api',
          path: '/workspace/platform/api',
          projectGroupId: 'root',
          connectionId: 'ssh-1'
        })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'root',
          name: 'Refund fix',
          folderPath: '/workspace/platform',
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()

    expect(store.getProjectGroups()[0]).toMatchObject({ id: 'root', connectionId: 'ssh-1' })
    expect(store.getFolderWorkspaces()[0]).toMatchObject({ id: 'fw-1', connectionId: 'ssh-1' })
  })

  it('backfills folder-scope SSH provenance from grouped repos despite unrelated same-path SSH repos', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'api-ssh-1',
          path: '/workspace/platform/api',
          projectGroupId: 'root',
          connectionId: 'ssh-1'
        }),
        makeRepo({
          id: 'api-ssh-2',
          path: '/workspace/platform/api',
          projectGroupId: 'other-root',
          connectionId: 'ssh-2'
        })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'other-root',
          name: 'Platform other',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 1,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'root',
          name: 'Refund fix',
          folderPath: '/workspace/platform',
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()

    expect(store.getProjectGroups().find((group) => group.id === 'root')).toMatchObject({
      connectionId: 'ssh-1'
    })
    expect(store.getFolderWorkspaces()[0]).toMatchObject({ id: 'fw-1', connectionId: 'ssh-1' })
  })

  it('removes folder workspace metadata and its scoped session state only', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    store.addRepo(
      makeRepo({ id: 'api', path: '/workspace/platform/api', projectGroupId: group.id })
    )
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Refund fix' })
    const key = folderWorkspaceKey(workspace.id)
    const tab = makeTerminalTab({ id: 'folder-tab', worktreeId: key })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeWorkspaceKey: key,
      activeWorktreeId: key,
      activeTabId: tab.id,
      tabsByWorktree: { [key]: [tab], 'repo::/wt': [makeTerminalTab({ id: 'repo-tab' })] },
      terminalLayoutsByTabId: {
        [tab.id]: { root: null, activeLeafId: null, expandedLeafId: null },
        'repo-tab': { root: null, activeLeafId: null, expandedLeafId: null }
      },
      browserTabsByWorktree: {
        [key]: [
          {
            id: 'browser-workspace',
            worktreeId: key,
            url: 'about:blank',
            title: 'Blank',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'browser-workspace': [
          {
            id: 'page-1',
            workspaceId: 'browser-workspace',
            worktreeId: key,
            url: 'about:blank',
            title: 'Blank',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeTabIdByWorktree: { [key]: tab.id },
      lastVisitedAtByWorktreeId: { [key]: 10 }
    })

    expect(store.removeFolderWorkspace(workspace.id)).toBe(true)

    const session = store.getWorkspaceSession()
    expect(store.getFolderWorkspaces()).toEqual([])
    expect(store.getProjectGroups()).toHaveLength(1)
    expect(store.getRepo('api')?.projectGroupId).toBe(group.id)
    expect(session.activeWorkspaceKey).toBeNull()
    expect(session.activeWorktreeId).toBeNull()
    expect(session.activeTabId).toBeNull()
    expect(session.tabsByWorktree[key]).toBeUndefined()
    expect(session.tabsByWorktree['repo::/wt']).toHaveLength(1)
    expect(session.terminalLayoutsByTabId['folder-tab']).toBeUndefined()
    expect(session.terminalLayoutsByTabId['repo-tab']).toBeDefined()
    expect(session.browserPagesByWorkspace?.['browser-workspace']).toBeUndefined()
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
      terminalFontWeight: 600
    })
    expect(updated.theme).toBe('dark')
    expect(updated.editorAutoSave).toBe(true)
    expect(updated.editorAutoSaveDelayMs).toBe(1500)
    expect(updated.appFontFamily).toBe('Inter')
    expect(updated.terminalFontSize).toBe(16)
    expect(updated.terminalFontWeight).toBe(600)
    // Other fields preserved
    expect(updated.branchPrefix).toBe('git-username')
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
      repos: [makeRepo()],
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

    store.updateSettings({ sourceControlViewMode: 'tree' })
    store.flush()

    const persisted = readDataFile() as {
      settings?: { sourceControlViewMode?: string }
      workspaceSession?: typeof workspaceSession
      worktreeMeta?: Record<string, unknown>
    }
    expect(persisted.settings?.sourceControlViewMode).toBe('tree')
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

    const reloaded = await createStore()
    expect(reloaded.getSettings().sourceControlViewMode).toBe('tree')
    expect(reloaded.getWorkspaceSession().activeWorktreeId).toBe('repo1::/worktree-a')
  })

  // ── 10. flush writes synchronously ─────────────────────────────────

  it('flush writes state to disk synchronously', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    store.flush()

    const persisted = readDataFile() as { repos: Repo[] }
    expect(persisted.repos).toHaveLength(1)
    expect(persisted.repos[0].id).toBe('r1')
  })

  it('flush remains safe when a debounced save is also pending', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.addRepo(makeRepo())
      store.flush()
      vi.advanceTimersByTime(300)

      const persisted = readDataFile() as { repos: Repo[] }
      expect(persisted.repos).toHaveLength(1)
      expect(persisted.repos[0].id).toBe('r1')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── 11. Debounced save ─────────────────────────────────────────────

  it('debounced save writes data after the delay', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.addRepo(makeRepo())

      // Before the debounce fires, file should not exist yet (or be stale)
      vi.advanceTimersByTime(100)
      // The 300ms debounce hasn't elapsed yet

      vi.advanceTimersByTime(300)
      // The timer fired; wait for the async disk write to complete
      await store.waitForPendingWrite()

      const persisted = readDataFile() as { repos: Repo[] }
      expect(persisted.repos).toHaveLength(1)
      expect(persisted.repos[0].id).toBe('r1')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── UI state ───────────────────────────────────────────────────────

  it('updateUI merges partial updates', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 400 })
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(400)
    expect(ui.groupBy).toBe('repo') // default preserved
    expect(ui.dismissedUpdateVersion).toBeNull()
  })

  it('updateUI persists sanitized per-worktree dotfile visibility', async () => {
    const store = await createStore()
    store.updateUI({
      showDotfilesByWorktree: {
        'repo-1::/repo': false,
        'repo-2::/repo': true,
        'repo-3::/repo': 'bad',
        constructor: false
      } as never
    })

    expect(store.getUI().showDotfilesByWorktree).toEqual({
      'repo-1::/repo': false,
      'repo-2::/repo': true
    })
  })

  it('updateUI skips save and notification when normalized UI is unchanged', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      const notifications: PersistedState['ui'][] = []
      store.updateUI({
        sidebarWidth: 400,
        showDotfilesByWorktree: { 'repo-1::/repo': false },
        featureTipsSeenIds: ['voice-dictation'],
        contextualToursSeenIds: ['tasks'],
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 1 }
        }
      })
      vi.advanceTimersByTime(300)
      await store.waitForPendingWrite()
      const persistedBefore = readFileSync(dataFile(), 'utf-8')
      store.onUIChanged((ui) => notifications.push(ui))

      store.updateUI({
        sidebarWidth: 400,
        showDotfilesByWorktree: { 'repo-1::/repo': false },
        featureTipsSeenIds: ['voice-dictation'],
        contextualToursSeenIds: ['tasks'],
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 1 }
        }
      })
      vi.advanceTimersByTime(300)
      await store.waitForPendingWrite()

      expect(notifications).toEqual([])
      expect(readFileSync(dataFile(), 'utf-8')).toBe(persistedBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('migrates missing rightSidebarOpen from the legacy default setting', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { rightSidebarOpenByDefault: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarOpen).toBe(false)
  })

  it('migrates missing rightSidebarOpen to open when the legacy default was open', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { rightSidebarOpenByDefault: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarOpen).toBe(true)
  })

  it('keeps explicit rightSidebarOpen authoritative over the legacy default setting', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { rightSidebarOpenByDefault: true },
      ui: { rightSidebarOpen: false },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarOpen).toBe(false)
  })

  it('preserves explicit rightSidebarTab in persisted UI', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { rightSidebarTab: 'checks' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarTab).toBe('checks')
  })

  it('preserves explicit rightSidebarExplorerView in persisted UI', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'search' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarTab).toBe('explorer')
    expect(store.getUI().rightSidebarExplorerView).toBe('search')
  })

  it('maps legacy persisted search tab to the Explorer search view', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { rightSidebarTab: 'search' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarTab).toBe('search')
    expect(store.getUI().rightSidebarExplorerView).toBe('search')
  })

  it('normalizes invalid rightSidebarTab in persisted UI', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { rightSidebarTab: 'bogus' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().rightSidebarTab).toBe('explorer')
  })

  it('updateUI merges feature interactions instead of replacing stale snapshots', async () => {
    const store = await createStore()

    store.updateUI({
      featureInteractions: {
        'agent-browser-use': { firstInteractedAt: 100, interactionCount: 1 }
      }
    })
    store.updateUI({
      featureInteractions: {
        tasks: { firstInteractedAt: 200, interactionCount: 1 }
      }
    })

    expect(store.getUI().featureInteractions).toEqual({
      'agent-browser-use': { firstInteractedAt: 100, interactionCount: 1 },
      tasks: { firstInteractedAt: 200, interactionCount: 1 }
    })
  })

  it('updateUI merges contextual tour seen ids instead of replacing stale snapshots', async () => {
    const store = await createStore()

    store.updateUI({
      contextualToursSeenIds: ['browser']
    })
    store.updateUI({
      contextualToursSeenIds: ['workspace-agent-sessions', 'unknown', 'browser'] as never
    })

    expect(store.getUI().contextualToursSeenIds).toEqual(['browser', 'workspace-agent-sessions'])
  })

  it('normalizes malformed persisted feature discovery state on read', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        featureTipsSeenIds: ['voice-dictation', 'unknown-tip', 'voice-dictation'],
        contextualToursSeenIds: ['tasks', 'unknown', 'tasks'] as never,
        featureInteractions: {
          tasks: { firstInteractedAt: 100 },
          automations: { firstInteractedAt: 150, interactionCount: 4 },
          browser: { firstInteractedAt: Number.NaN },
          unknown: { firstInteractedAt: 200 }
        }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getUI().featureTipsSeenIds).toEqual(['voice-dictation'])
    expect(store.getUI().contextualToursSeenIds).toEqual(['tasks'])
    expect(store.getUI().featureInteractions).toEqual({
      tasks: { firstInteractedAt: 100, interactionCount: 1 },
      automations: { firstInteractedAt: 150, interactionCount: 4 }
    })
  })

  it('normalizes malformed main-owned feature telemetry bucket markers on read', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      featureInteractionTelemetryBuckets: {
        tasks: 'count_2',
        browser: 'count_4',
        unknown: 'count_1'
      }
    })

    const store = await createStore()
    store.flush()

    const persisted = readDataFile() as PersistedState
    expect(persisted.featureInteractionTelemetryBuckets).toEqual({ tasks: 'count_2' })
  })

  it('does not expose or accept UI shadow writes for main-owned feature telemetry markers', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        featureInteractionTelemetryBuckets: { tasks: 'count_1000_plus' }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      featureInteractionTelemetryBuckets: { tasks: 'count_2' }
    })

    const store = await createStore()

    expect('featureInteractionTelemetryBuckets' in (store.getUI() as Record<string, unknown>)).toBe(
      false
    )

    store.updateUI({
      featureInteractionTelemetryBuckets: { tasks: 'count_500_999' }
    } as never)
    store.flush()

    const persisted = readDataFile() as PersistedState & {
      ui: Record<string, unknown>
    }
    expect(persisted.featureInteractionTelemetryBuckets).toEqual({ tasks: 'count_2' })
    expect(persisted.ui.featureInteractionTelemetryBuckets).toBeUndefined()
  })

  it('normalizes feature tip ids from direct UI writes', async () => {
    const store = await createStore()

    store.updateUI({
      featureTipsSeenIds: ['voice-dictation', 'unknown-tip', 'voice-dictation'] as never
    })

    expect(store.getUI().featureTipsSeenIds).toEqual(['voice-dictation'])
  })

  it('recordFeatureInteraction increments from the current persisted UI state', async () => {
    const store = await createStore()

    store.updateUI({
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 2 }
      }
    })

    const ui = store.recordFeatureInteraction('tasks')

    expect(ui.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 3
    })
    expect(store.getUI().featureInteractions?.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 3
    })
  })

  it('emits feature interaction telemetry only when a higher bucket is reached', async () => {
    const store = await createStore()

    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')
    store.flush()

    expect(trackMock).toHaveBeenCalledTimes(3)
    expect(trackMock).toHaveBeenNthCalledWith(1, 'feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_1',
      bucket_source: 'crossed_now',
      nth_repo_added: 2
    })
    expect(trackMock).toHaveBeenNthCalledWith(2, 'feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_2',
      bucket_source: 'crossed_now',
      nth_repo_added: 2
    })
    expect(trackMock).toHaveBeenNthCalledWith(3, 'feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_3_4',
      bucket_source: 'crossed_now',
      nth_repo_added: 2
    })
    expect((readDataFile() as PersistedState).featureInteractionTelemetryBuckets).toEqual({
      tasks: 'count_3_4'
    })
  })

  it('emits one observed-existing bucket for pre-rollout interaction counts', async () => {
    const store = await createStore()
    store.updateUI({
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 137 }
      }
    })
    trackMock.mockClear()

    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')
    store.flush()

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_100_199',
      bucket_source: 'observed_existing',
      nth_repo_added: 2
    })
    expect((readDataFile() as PersistedState).featureInteractionTelemetryBuckets).toEqual({
      tasks: 'count_100_199'
    })
  })

  it('emits only the top-coded observed-existing bucket for pre-rollout power users', async () => {
    const store = await createStore()
    store.updateUI({
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 1200 }
      }
    })
    trackMock.mockClear()

    store.recordFeatureInteraction('tasks')

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_1000_plus',
      bucket_source: 'observed_existing',
      nth_repo_added: 2
    })
  })

  it('emits high bucket crossings once and ignores same-range increments', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 198 }
        }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      featureInteractionTelemetryBuckets: { tasks: 'count_100_199' }
    })
    const store = await createStore()

    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_200_499',
      bucket_source: 'crossed_now',
      nth_repo_added: 2
    })
  })

  it('does not emit for count 4 but emits the count_1000_plus crossing', async () => {
    const store = await createStore()

    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')
    store.recordFeatureInteraction('tasks')
    trackMock.mockClear()

    store.recordFeatureInteraction('tasks')
    expect(trackMock).not.toHaveBeenCalled()

    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 999 }
        }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      featureInteractionTelemetryBuckets: { tasks: 'count_500_999' }
    })
    const reloaded = await createStore()

    reloaded.recordFeatureInteraction('tasks')
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('feature_interaction_usage_bucket_reached', {
      feature_id: 'tasks',
      feature_category: 'task_management',
      count_bucket: 'count_1000_plus',
      bucket_source: 'crossed_now',
      nth_repo_added: 2
    })
  })

  it('dedupes against the persisted bucket marker', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 100 }
        }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      featureInteractionTelemetryBuckets: { tasks: 'count_100_199' }
    })
    const store = await createStore()

    store.recordFeatureInteraction('tasks')

    expect(trackMock).not.toHaveBeenCalled()
  })

  it('updateUI preserves selected card properties from direct UI writes', async () => {
    const store = await createStore()
    store.updateUI({ worktreeCardProperties: ['inline-agents'] })

    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread', 'inline-agents'])
  })

  it('persists updater reminder metadata in UI state', async () => {
    const store = await createStore()
    store.updateUI({ dismissedUpdateVersion: '1.0.99', lastUpdateCheckAt: 1234 })
    const ui = store.getUI()
    expect(ui.dismissedUpdateVersion).toBe('1.0.99')
    expect(ui.lastUpdateCheckAt).toBe(1234)
  })

  it('normalizes default browser zoom UI writes', async () => {
    const store = await createStore()

    store.updateUI({ browserDefaultZoomLevel: 1.26 })

    expect(store.getUI().browserDefaultZoomLevel).toBe(1.5)
  })

  it('encrypts the Kagi session link on disk and decrypts it on load', async () => {
    const sessionLink = 'https://kagi.com/search?token=secret'
    const store = await createStore()

    store.updateUI({ browserKagiSessionLink: sessionLink })
    store.flush()

    const persisted = readDataFile() as { ui: { browserKagiSessionLink: string } }
    expect(persisted.ui.browserKagiSessionLink).not.toBe(sessionLink)

    const reloaded = await createStore()
    expect(reloaded.getUI().browserKagiSessionLink).toBe(sessionLink)
  })

  it('keeps plaintext Kagi session links readable for migration from older builds', async () => {
    const sessionLink = 'https://kagi.com/search?token=secret'
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { browserKagiSessionLink: sessionLink },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().browserKagiSessionLink).toBe(sessionLink)
  })

  it('preserves persisted smart sort value', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { sortBy: 'smart' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('smart')
  })

  it('migrates legacy recent sort to smart on first load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { sortBy: 'recent' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('smart')
    expect(store.getUI()._sortBySmartMigrated).toBe(true)
  })

  it('preserves new recent sort after migration flag is set', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { sortBy: 'recent', _sortBySmartMigrated: true },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('recent')
  })

  it('uses recent as the default sort for a fresh install (no persisted sortBy)', async () => {
    // Why: the legacy-recent→smart migration must gate on the *raw* persisted
    // value, not the normalized default. Otherwise, changing the default sort
    // to 'recent' would cause every fresh install to be mis-migrated to 'smart'.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('recent')
  })

  it('defaults workspace board task status sync off and normalizes persisted values', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { syncTaskStatusFromWorkspaceBoard: 'yes' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().syncTaskStatusFromWorkspaceBoard).toBe(false)

    store.updateUI({ syncTaskStatusFromWorkspaceBoard: true })
    expect(store.getUI().syncTaskStatusFromWorkspaceBoard).toBe(true)
  })

  it('repairs the known-bad reordered default workspace statuses once on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { workspaceStatuses: REORDERED_DEFAULT_WORKSPACE_STATUSES },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const ui = store.getUI()
    expect(ui.workspaceStatuses?.map((status) => status.id)).toEqual([
      'completed',
      'in-review',
      'in-progress',
      'todo'
    ])
    expect(ui.workspaceStatuses?.[0]?.label).toBe('Done')
    expect(ui._workspaceStatusesDefaultOrderMigrated).toBe(true)
    expect(ui._workspaceStatusesDefaultWorkflowMigrated).toBe(true)

    store.flush()
    const persisted = readDataFile() as {
      ui?: {
        workspaceStatuses?: typeof REORDERED_DEFAULT_WORKSPACE_STATUSES
        _workspaceStatusesDefaultOrderMigrated?: boolean
        _workspaceStatusesDefaultWorkflowMigrated?: boolean
        _workspaceStatusesDefaultVisualsMigrated?: boolean
      }
    }
    expect(persisted.ui?._workspaceStatusesDefaultOrderMigrated).toBe(true)
    expect(persisted.ui?._workspaceStatusesDefaultWorkflowMigrated).toBe(true)
    expect(persisted.ui?._workspaceStatusesDefaultVisualsMigrated).toBe(true)
    expect(persisted.ui?.workspaceStatuses?.map((status) => status.id)).toEqual([
      'completed',
      'in-review',
      'in-progress',
      'todo'
    ])
    expect(persisted.ui?.workspaceStatuses?.[0]?.label).toBe('Done')
  })

  it('migrates legacy default workspace status visuals and workflow once on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        workspaceStatuses: LEGACY_DEFAULT_WORKSPACE_STATUSES,
        _workspaceStatusesDefaultOrderMigrated: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().workspaceStatuses).toEqual(WORKFLOW_DEFAULT_WORKSPACE_STATUSES)
    expect(store.getUI()._workspaceStatusesDefaultWorkflowMigrated).toBe(true)
    expect(store.getUI()._workspaceStatusesDefaultVisualsMigrated).toBe(true)

    store.flush()
    const persisted = readDataFile() as {
      ui?: {
        _workspaceStatusesDefaultWorkflowMigrated?: boolean
        _workspaceStatusesDefaultVisualsMigrated?: boolean
      }
    }
    expect(persisted.ui?._workspaceStatusesDefaultWorkflowMigrated).toBe(true)
    expect(persisted.ui?._workspaceStatusesDefaultVisualsMigrated).toBe(true)
  })

  it('preserves legacy-looking workspace status visuals after the load migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        workspaceStatuses: LEGACY_DEFAULT_WORKSPACE_STATUSES,
        _workspaceStatusesDefaultOrderMigrated: true,
        _workspaceStatusesDefaultWorkflowMigrated: true,
        _workspaceStatusesDefaultVisualsMigrated: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const inProgress = store
      .getUI()
      .workspaceStatuses?.find((status) => status.id === 'in-progress')
    expect(inProgress).toMatchObject({ color: 'blue', icon: 'circle-dot' })
  })

  it('preserves intentionally reordered default workspace statuses after the load migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        workspaceStatuses: REORDERED_DEFAULT_WORKSPACE_STATUSES,
        _workspaceStatusesDefaultOrderMigrated: true,
        _workspaceStatusesDefaultWorkflowMigrated: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().workspaceStatuses?.map((status) => status.id)).toEqual([
      'completed',
      'in-review',
      'in-progress',
      'todo'
    ])
  })

  // ── terminalMacOptionAsAlt migration (issue #903) ───────────────────

  it('migrates legacy "true" terminalMacOptionAsAlt to "auto" on first load', async () => {
    // Why: before the 'auto' mode shipped, 'true' was the global default.
    // A persisted 'true' on an un-migrated install is indistinguishable
    // from an explicit choice, so we flip to 'auto' and let detection pick
    // the right value per keyboard layout. Non-US users stop losing their
    // @ / € / [ ] characters.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'true' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('migrates inherited terminal bar cursor defaults to block on first load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalCursorStyle: 'bar' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalCursorStyle).toBe('block')
    expect(store.getSettings().terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('preserves terminal cursor choices after the block-default migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalCursorStyle: 'bar', terminalCursorStyleDefaultedToBlock: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalCursorStyle).toBe('bar')
    expect(store.getSettings().terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('preserves explicit "false" terminalMacOptionAsAlt through migration', async () => {
    // 'false' never matched the old default — it was an explicit choice.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'false' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('false')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('preserves explicit "left" / "right" terminalMacOptionAsAlt through migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'left' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('left')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('respects already-migrated settings with explicit "true"', async () => {
    // After migration, if a user deliberately picks 'Both' in the UI,
    // their choice is preserved on subsequent launches.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'true', terminalMacOptionAsAltMigrated: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('true')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('fresh install defaults terminalMacOptionAsAlt to "auto" and marks migrated', async () => {
    // No data file at all: auto is the new default; migration is considered
    // complete since there's nothing legacy to migrate.
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    // Fresh install: default is migrated=false (nothing loaded, so the
    // migration code didn't run). On first persisted write, the flag stays
    // false, which is fine — next load with legacy 'true' would still
    // migrate correctly. Only loaded files flip the flag.
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(false)
  })

  it('missing terminalMacOptionAsAlt in persisted file defaults to "auto" and flags migrated', async () => {
    // Existing file predates the setting entirely. Treat like upgrade from
    // pre-Option-as-Alt Orca: land on 'auto' and mark migrated so we don't
    // re-examine.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('migrates the legacy experimentalSidekick setting to experimentalPet', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalSidekick: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalPet).toBe(true)
  })

  it('migrates the legacy experimental compact worktree cards setting', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalCompactWorktreeCards: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getSettings().experimentalCompactWorktreeCards).toBeUndefined()
  })

  it('defaults legacy experimentalActivity profiles off once', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalActivity: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalActivity).toBe(false)
    expect(store.getSettings().experimentalActivityDefaultedOffForAllUsers).toBe(true)
  })

  it('preserves experimentalActivity after the default-off migration has run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        experimentalActivity: true,
        experimentalActivityDefaultedOffForAllUsers: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalActivity).toBe(true)
  })

  // ── worktree-card property migration ───────────────────────────────

  it('adds split-out default card properties for legacy detailed profiles', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment']
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ci',
      'issue',
      'linear-issue',
      'pr',
      'comment',
      'ports',
      'inline-agents'
    ])
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
    expect(store.getUI()._expandedWorktreeCardPropertiesDefaulted).toBe(true)
  })

  it('adds split-out default card properties without duplicating inline agents', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'ci',
          'issue',
          'pr',
          'comment',
          'inline-agents'
        ]
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ci',
      'issue',
      'linear-issue',
      'pr',
      'comment',
      'ports',
      'inline-agents'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
    expect(store.getUI()._expandedWorktreeCardPropertiesDefaulted).toBe(true)
  })

  it('derives fresh default profiles without branch', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'pr',
      'automation',
      'comment',
      'ports',
      'inline-agents'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI()._worktreeCardModeDefaulted).toBe(true)
  })

  it('adds split-out defaults even when the mode marker exists but expansion has not run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr'],
        _worktreeCardModeDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ci',
      'issue',
      'linear-issue',
      'pr',
      'ports',
      'inline-agents'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
  })

  it('preserves deliberate post-migration card property opt-outs', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'pr'],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread', 'pr'])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI().worktreeCardProperties).not.toContain('ports')
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('does not re-add branch after an explicit Default mode selection', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'issue',
          'linear-issue',
          'pr',
          'comment',
          'ports',
          'inline-agents'
        ],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
  })

  it('preserves explicit Compact card properties after expansion has run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'issue',
          'linear-issue',
          'pr',
          'comment',
          'ports'
        ],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'pr',
      'comment',
      'ports'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('uses the default preset when card properties are missing', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'pr',
      'automation',
      'comment',
      'ports',
      'inline-agents'
    ])
  })

  // ── GitHub Cache ───────────────────────────────────────────────────

  it('get/set GitHub cache round-trips', async () => {
    const store = await createStore()
    const cache = {
      pr: { 'owner/repo#1': { data: null, fetchedAt: 1000 } },
      issue: {}
    }
    store.setGitHubCache(cache)
    expect(store.getGitHubCache()).toEqual(cache)
  })

  // ── Workspace Session ──────────────────────────────────────────────

  it('get/set workspace session round-trips', async () => {
    const store = await createStore()
    const session = {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    store.setWorkspaceSession(session)
    expect(store.getWorkspaceSession()).toEqual(session)
  })

  it('patches workspace session without replacing unchanged slices', async () => {
    const store = await createStore()
    const tabsByWorktree = {
      wt1: [makeTerminalTab({ id: 'tab1', ptyId: null, worktreeId: 'wt1' })]
    }
    const terminalLayoutsByTabId = {
      tab1: { root: null, activeLeafId: null, expandedLeafId: null }
    }
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree,
      terminalLayoutsByTabId,
      activeConnectionIdsAtShutdown: ['ssh-1']
    })

    store.patchWorkspaceSession({
      activeTabId: 'tab2',
      activeConnectionIdsAtShutdown: undefined
    })

    const session = store.getWorkspaceSession()
    expect(session.activeTabId).toBe('tab2')
    expect(session.tabsByWorktree).toEqual(tabsByWorktree)
    expect(session.terminalLayoutsByTabId).toEqual(terminalLayoutsByTabId)
    expect(session.activeConnectionIdsAtShutdown).toBeUndefined()
  })

  it('uses full normalization for structural workspace session patches', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-repo', connectionId: null }))
    store.setWorkspaceSession({
      activeRepoId: 'local-repo',
      activeWorktreeId: 'local-repo::/worktree',
      activeTabId: 'tab-local',
      tabsByWorktree: {
        'local-repo::/worktree': [
          makeTerminalTab({
            id: 'tab-local',
            ptyId: 'pty-local',
            worktreeId: 'local-repo::/worktree'
          })
        ]
      },
      terminalLayoutsByTabId: {}
    })

    store.patchWorkspaceSession({
      terminalLayoutsByTabId: {
        'tab-local': {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          buffersByLeafId: { [TEST_LEAF_1]: 'local-scrollback' },
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-local' }
        }
      }
    })

    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['tab-local'].buffersByLeafId
    ).toBeUndefined()
  })

  it('stores remote terminal scrollback out of workspace session JSON', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-repo', connectionId: null }))
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))

    store.setWorkspaceSession(makeSessionWithTerminalBuffers())

    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['local-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['local-tab'].ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'local-pty'
    })
    expect(session.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId).toEqual({
      [TEST_LEAF_2]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref = session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[TEST_LEAF_2]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('remote-scrollback')
  })

  it('caps oversized browser history when setting workspace session', async () => {
    const store = await createStore()
    const oversizedSession = makeSessionWithBrowserHistory(500)
    const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedSession))

    store.setWorkspaceSession(oversizedSession)

    const session = store.getWorkspaceSession()
    const prunedBytes = Buffer.byteLength(JSON.stringify(session))
    expect(session.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(session.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
    expect(prunedBytes).toBeLessThan(oversizedBytes / 2)
  })

  it('stores maybe-remote terminal scrollback out of workspace session JSON', async () => {
    const store = await createStore()

    store.setWorkspaceSession({
      activeRepoId: 'remote-repo',
      activeWorktreeId: 'remote-repo::/remote',
      activeTabId: 'remote-tab',
      tabsByWorktree: {
        'remote-repo::/remote': [
          makeTerminalTab({
            id: 'remote-tab',
            ptyId: 'remote-pty',
            worktreeId: 'remote-repo::/remote'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'remote-tab': {
          root: { type: 'leaf', leafId: TEST_LEAF_2 },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          buffersByLeafId: { [TEST_LEAF_2]: 'maybe-remote-scrollback' }
        }
      }
    })

    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].buffersByLeafId
    ).toBeUndefined()
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId
    ).toEqual({
      [TEST_LEAF_2]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[
        TEST_LEAF_2
      ]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('maybe-remote-scrollback')
  })

  it('deletes terminal scrollback snapshot files when refs leave the workspace session', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))
    const session = makeSessionWithTerminalBuffers()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: { 'remote-repo::/remote': session.tabsByWorktree['remote-repo::/remote'] },
      terminalLayoutsByTabId: { 'remote-tab': session.terminalLayoutsByTabId['remote-tab'] }
    })
    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[
        TEST_LEAF_2
      ]
    expect(ref).toEqual(expect.stringMatching(/^v1-[0-9a-f]{32}$/))
    if (!ref) {
      throw new Error('expected scrollback snapshot ref')
    }
    expect(existsSync(join(testState.dir, 'terminal-scrollback', `${ref}.bin`))).toBe(true)

    store.setWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    expect(existsSync(join(testState.dir, 'terminal-scrollback', `${ref}.bin`))).toBe(false)
  })

  it('reads only the replay tail from oversized terminal scrollback snapshots', async () => {
    const store = await createStore()
    const ref = 'v1-00000000000000000000000000000000'
    const snapshotDir = join(testState.dir, 'terminal-scrollback')
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(
      join(snapshotDir, `${ref}.bin`),
      `stale-prefix-${'x'.repeat(TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)}tail`,
      'utf-8'
    )

    const buffer = store.readTerminalScrollbackSnapshot(ref)

    expect(buffer).toHaveLength(TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
    expect(buffer?.startsWith('stale-prefix')).toBe(false)
    expect(buffer?.endsWith('tail')).toBe(true)
  })

  it('strips legacy local terminal scrollback buffers when loading workspace session', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({ id: 'local-repo', connectionId: null }),
        makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: makeSessionWithTerminalBuffers()
    })

    const store = await createStore()
    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['local-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId).toEqual({
      [TEST_LEAF_2]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref = session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[TEST_LEAF_2]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('remote-scrollback')
  })

  it('caps oversized legacy browser history when loading workspace session', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: makeSessionWithBrowserHistory(500)
    })

    const store = await createStore()
    const session = store.getWorkspaceSession()
    expect(session.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(session.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
  })

  it('remaps legacy SSH lease leaf ids when loading legacy workspace layouts', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'remote-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: 'pane:1' },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'remote-pty' }
          }
        }
      },
      sshRemotePtyLeases: [
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    const leafId = layout.root?.type === 'leaf' ? layout.root.leafId : null
    if (leafId === null) {
      throw new Error('Expected remapped leaf id')
    }
    expect(isTerminalLeafId(leafId)).toBe(true)
    expect(layout.ptyIdsByLeafId).toEqual({ [leafId]: 'remote-pty' })
    expect(store.getSshRemotePtyLeases('ssh-1')[0].leafId).toBe(leafId)
  })

  it('hydrates legacy numeric agent status cache through the pane identity migration', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: 'pane:1' },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'local-pty' }
          }
        }
      }
    })
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: Date.now(),
            stateStartedAt: Date.now() - 1000,
            payload: { state: 'working', prompt: 'legacy numeric prompt', agentType: 'claude' }
          }
        }
      }),
      'utf-8'
    )

    const store = await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
      const leafId = layout.root?.type === 'leaf' ? layout.root.leafId : null
      if (leafId === null) {
        throw new Error('Expected remapped leaf id')
      }
      const stablePaneKey = makePaneKey('tab1', leafId)
      expect(agentHookServer.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: stablePaneKey,
          tabId: 'tab1',
          worktreeId: 'wt1',
          state: 'working',
          prompt: 'legacy numeric prompt',
          agentType: 'claude'
        })
      ])
    } finally {
      agentHookServer.stop()
    }
  })

  it('hydrates split-pane legacy numeric agent status rows onto the matching remapped leaves', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty-1'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' },
              sizes: [50, 50]
            },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'local-pty-1', 'pane:2': 'local-pty-2' }
          }
        }
      }
    })
    const now = Date.now()
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 2000,
            payload: { state: 'working', prompt: 'left legacy prompt', agentType: 'claude' }
          },
          'tab1:2': {
            paneKey: 'tab1:2',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 1000,
            payload: { state: 'blocked', prompt: 'right legacy prompt', agentType: 'codex' }
          }
        }
      }),
      'utf-8'
    )

    const store = await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
      const firstLeafId =
        layout.root?.type === 'split' && layout.root.first.type === 'leaf'
          ? layout.root.first.leafId
          : null
      const secondLeafId =
        layout.root?.type === 'split' && layout.root.second.type === 'leaf'
          ? layout.root.second.leafId
          : null
      if (firstLeafId === null || secondLeafId === null) {
        throw new Error('Expected remapped split leaves')
      }
      const byPaneKey = new Map(
        agentHookServer.getStatusSnapshot().map((entry) => [entry.paneKey, entry])
      )

      expect(byPaneKey.get(makePaneKey('tab1', firstLeafId))).toEqual(
        expect.objectContaining({
          state: 'working',
          prompt: 'left legacy prompt',
          agentType: 'claude'
        })
      )
      expect(byPaneKey.get(makePaneKey('tab1', secondLeafId))).toEqual(
        expect.objectContaining({
          state: 'blocked',
          prompt: 'right legacy prompt',
          agentType: 'codex'
        })
      )
    } finally {
      agentHookServer.stop()
    }
  })

  it('hydrates split-pane legacy status rows even when PTY leaf bindings are absent', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty-1'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' },
              sizes: [50, 50]
            },
            activeLeafId: 'pane:2',
            expandedLeafId: null
          }
        }
      }
    })
    const now = Date.now()
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 2000,
            payload: { state: 'working', prompt: 'left no binding', agentType: 'claude' }
          },
          'tab1:2': {
            paneKey: 'tab1:2',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 1000,
            payload: { state: 'blocked', prompt: 'right no binding', agentType: 'codex' }
          }
        }
      }),
      'utf-8'
    )

    const store = await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
      const firstLeafId =
        layout.root?.type === 'split' && layout.root.first.type === 'leaf'
          ? layout.root.first.leafId
          : null
      const secondLeafId =
        layout.root?.type === 'split' && layout.root.second.type === 'leaf'
          ? layout.root.second.leafId
          : null
      if (firstLeafId === null || secondLeafId === null) {
        throw new Error('Expected remapped split leaves')
      }
      const byPaneKey = new Map(
        agentHookServer.getStatusSnapshot().map((entry) => [entry.paneKey, entry])
      )

      expect(byPaneKey.get(makePaneKey('tab1', firstLeafId))).toEqual(
        expect.objectContaining({
          state: 'working',
          prompt: 'left no binding',
          agentType: 'claude'
        })
      )
      expect(byPaneKey.get(makePaneKey('tab1', secondLeafId))).toEqual(
        expect.objectContaining({
          state: 'blocked',
          prompt: 'right no binding',
          agentType: 'codex'
        })
      )
    } finally {
      agentHookServer.stop()
    }
  })

  it('persists legacy pane-key aliases after the layout has been normalized', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: 'pane:1' },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'local-pty' }
          }
        }
      }
    })

    const firstStore = await createStore()
    const root = firstStore.getWorkspaceSession().terminalLayoutsByTabId.tab1.root
    const stableLeafId = root?.type === 'leaf' ? root.leafId : null
    if (stableLeafId === null) {
      throw new Error('Expected remapped leaf id')
    }
    const stablePaneKey = makePaneKey('tab1', stableLeafId)
    firstStore.flush()

    expect(readDataFile()).toEqual(
      expect.objectContaining({
        legacyPaneKeyAliasEntries: [
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:1',
            stablePaneKey
          })
        ]
      })
    )

    const now = Date.now()
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 1000,
            payload: { state: 'working', prompt: 'post-normalize legacy prompt' }
          }
        }
      }),
      'utf-8'
    )

    await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      expect(agentHookServer.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: stablePaneKey,
          state: 'working',
          prompt: 'post-normalize legacy prompt'
        })
      ])
    } finally {
      agentHookServer.stop()
    }
  })

  it('persists fallback aliases when a legacy split layout has no PTY leaf bindings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' },
              sizes: [50, 50]
            },
            activeLeafId: 'pane:2',
            expandedLeafId: null
          }
        }
      }
    })

    const store = await createStore()
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    const firstLeafId =
      layout.root?.type === 'split' && layout.root.first.type === 'leaf'
        ? layout.root.first.leafId
        : null
    const secondLeafId =
      layout.root?.type === 'split' && layout.root.second.type === 'leaf'
        ? layout.root.second.leafId
        : null
    if (
      !firstLeafId ||
      !secondLeafId ||
      !isTerminalLeafId(firstLeafId) ||
      !isTerminalLeafId(secondLeafId)
    ) {
      throw new Error('Expected remapped split leaf ids')
    }
    const activePaneKey = makePaneKey('tab1', secondLeafId)
    const firstPaneKey = makePaneKey('tab1', firstLeafId)
    const secondPaneKey = makePaneKey('tab1', secondLeafId)
    store.flush()

    expect(readDataFile()).toEqual(
      expect.objectContaining({
        legacyPaneKeyAliasEntries: expect.arrayContaining([
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:0',
            stablePaneKey: activePaneKey
          }),
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:1',
            stablePaneKey: firstPaneKey
          }),
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:2',
            stablePaneKey: secondPaneKey
          })
        ])
      })
    )
  })

  it('loads legacy pane aliases from very large persisted split layouts', async () => {
    const leafCount = 130_000
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'large-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: makeBalancedLegacyPaneLayout(0, leafCount),
            activeLeafId: 'pane:1',
            expandedLeafId: null
          }
        }
      }
    })

    const store = await createStore()
    store.flush()

    const persisted = readDataFile() as PersistedState
    const aliasEntries = persisted.legacyPaneKeyAliasEntries
    expect(aliasEntries).toHaveLength(leafCount + 1)
    expect(
      aliasEntries.some((entry) => entry.ptyId === 'large-pty' && entry.legacyPaneKey === 'tab1:0')
    ).toBe(true)
    expect(
      aliasEntries.some((entry) => entry.ptyId === 'large-pty' && entry.legacyPaneKey === 'tab1:1')
    ).toBe(true)
    expect(
      aliasEntries.some(
        (entry) => entry.ptyId === 'large-pty' && entry.legacyPaneKey === `tab1:${leafCount}`
      )
    ).toBe(true)
  })

  it('converts unambiguous dev migration rows into persisted aliases', async () => {
    const stablePaneKey = makePaneKey('tab1', TEST_LEAF_1)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: TEST_LEAF_1 },
            activeLeafId: TEST_LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [TEST_LEAF_1]: 'local-pty' }
          }
        }
      },
      migrationUnsupportedPtyEntries: [
        {
          ptyId: 'local-pty',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          paneKey: stablePaneKey,
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 123
        }
      ]
    })

    const store = await createStore()
    store.flush()

    expect(readDataFile()).toEqual(
      expect.objectContaining({
        migrationUnsupportedPtyEntries: [],
        legacyPaneKeyAliasEntries: expect.arrayContaining([
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:0',
            stablePaneKey
          }),
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:1',
            stablePaneKey
          })
        ])
      })
    )
  })

  it('remaps legacy SSH lease leaf ids by PTY when the layout is already normalized', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'remote-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: TEST_LEAF_1 },
            activeLeafId: TEST_LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
          }
        }
      },
      sshRemotePtyLeases: [
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    expect(store.getSshRemotePtyLeases('ssh-1')[0].leafId).toBe(TEST_LEAF_1)
  })

  it('normalizes stale legacy session writes to prior UUID leaves before preserving bindings', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    const layout = session.terminalLayoutsByTabId.tab1
    expect(layout.root).toEqual({ type: 'leaf', leafId: TEST_LEAF_1 })
    expect(layout.ptyIdsByLeafId).toEqual({ [TEST_LEAF_1]: 'remote-pty' })
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('remote-pty')
  })

  it('promotes an empty tab layout to a durable UUID root when persisting the first PTY binding', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null
        }
      }
    })

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      ptyId: 'daemon-pty'
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('daemon-pty')
    expect(session.terminalLayoutsByTabId.tab1).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'daemon-pty' }
    })
  })

  it('adds a missing split leaf to the durable root when a new pane spawns before layout debounce', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
        }
      }
    })

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-2'
    })

    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    expect(layout.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: TEST_LEAF_1 },
      second: { type: 'leaf', leafId: TEST_LEAF_2 }
    })
    expect(layout.activeLeafId).toBe(TEST_LEAF_2)
    expect(layout.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'pty-1',
      [TEST_LEAF_2]: 'pty-2'
    })

    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'pty-1',
      [TEST_LEAF_2]: 'pty-2'
    })
  })

  it('preserves a sync-persisted UUID root when a stale empty layout write arrives', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null
        }
      }
    })

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      ptyId: 'daemon-pty'
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('daemon-pty')
    expect(session.terminalLayoutsByTabId.tab1).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'daemon-pty' }
    })
  })

  it('drops legacy leaf-keyed records from mixed-version writes before binding preservation', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'daemon-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'daemon-pty' },
          buffersByLeafId: { [TEST_LEAF_1]: 'Current buffer' },
          titlesByLeafId: { [TEST_LEAF_1]: 'Current' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: 'pane:1',
          expandedLeafId: 'pane:1',
          ptyIdsByLeafId: { 'pane:1': 'stale-pty' },
          buffersByLeafId: { 'pane:1': 'Stale buffer' },
          titlesByLeafId: { 'pane:1': 'Stale' }
        }
      }
    })

    const session = store.getWorkspaceSession()
    const layout = session.terminalLayoutsByTabId.tab1
    expect(layout.activeLeafId).toBe(TEST_LEAF_1)
    expect(layout.expandedLeafId).toBeNull()
    expect(layout.ptyIdsByLeafId).toEqual({ [TEST_LEAF_1]: 'daemon-pty' })
    expect(layout.buffersByLeafId).toBeUndefined()
    expect(layout.scrollbackRefsByLeafId).toEqual({
      [TEST_LEAF_1]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref = layout.scrollbackRefsByLeafId?.[TEST_LEAF_1]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('Current buffer')
    expect(layout.titlesByLeafId).toEqual({ [TEST_LEAF_1]: 'Current' })
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('daemon-pty')
  })

  it('does not reuse prior UUID leaves by position when legacy leaf counts changed', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null
        }
      }
    })

    const root = store.getWorkspaceSession().terminalLayoutsByTabId.tab1.root
    const leafId = root?.type === 'leaf' ? root.leafId : null
    if (leafId === null) {
      throw new Error('Expected normalized leaf')
    }
    expect(isTerminalLeafId(leafId)).toBe(true)
    expect(leafId).not.toBe(TEST_LEAF_1)
    expect(leafId).not.toBe(TEST_LEAF_2)
  })

  it('does not restore cleared SSH bindings after a lease expired', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('does not let an expired lease for another tab suppress a matching pty id', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab-expired',
      leafId: TEST_LEAF_EXPIRED,
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-live',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: TEST_LEAF_LIVE },
          activeLeafId: TEST_LEAF_LIVE,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_LIVE]: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-live',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: TEST_LEAF_LIVE },
          activeLeafId: TEST_LEAF_LIVE,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('remote-pty')
    expect(session.terminalLayoutsByTabId['tab-live'].ptyIdsByLeafId).toEqual({
      [TEST_LEAF_LIVE]: 'remote-pty'
    })
  })

  it('does not let an expired lease for another SSH target suppress the same tab binding', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'repo-live', connectionId: 'ssh-live' }))
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-expired',
      ptyId: 'remote-pty',
      worktreeId: 'repo-live::/wt',
      tabId: 'tab-live',
      leafId: TEST_LEAF_LIVE,
      state: 'expired'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-live',
      ptyId: 'remote-pty',
      worktreeId: 'repo-live::/wt',
      tabId: 'tab-live',
      leafId: TEST_LEAF_LIVE,
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'repo-live',
      activeWorktreeId: 'repo-live::/wt',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        'repo-live::/wt': [
          {
            id: 'tab-live',
            worktreeId: 'repo-live::/wt',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: TEST_LEAF_LIVE },
          activeLeafId: TEST_LEAF_LIVE,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_LIVE]: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'repo-live',
      activeWorktreeId: 'repo-live::/wt',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        'repo-live::/wt': [
          {
            id: 'tab-live',
            worktreeId: 'repo-live::/wt',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: TEST_LEAF_LIVE },
          activeLeafId: TEST_LEAF_LIVE,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree['repo-live::/wt'][0].ptyId).toBe('remote-pty')
    expect(session.terminalLayoutsByTabId['tab-live'].ptyIdsByLeafId).toEqual({
      [TEST_LEAF_LIVE]: 'remote-pty'
    })
  })

  it('does not treat contextless expired leases as wildcards for contextual bindings', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('remote-pty')
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'remote-pty'
    })
  })

  it('does not treat layout-level leases missing worktree context as contextual matches', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'remote-pty'
    })
  })

  it('merges missing prior layout bindings into partial renderer snapshots', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'remote-pty-1',
            [TEST_LEAF_2]: 'remote-pty-2'
          }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'remote-pty-1',
      [TEST_LEAF_2]: 'remote-pty-2'
    })
  })

  it('does not restore layout bindings for leaves removed from the incoming layout', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'remote-pty-1',
            [TEST_LEAF_2]: 'remote-pty-2'
          }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'remote-pty-1'
    })
  })

  it('does not restore missing layout bindings without a live SSH lease', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'local-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'local-pty-1',
            [TEST_LEAF_2]: 'local-pty-2'
          }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'local-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'local-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'local-pty-1'
    })
  })

  it('clears workspace bindings before removing SSH remote PTY leases for a target', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('clears workspace bindings when marking all SSH remote PTY leases for a target terminated', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.markSshRemotePtyLeases('ssh-1', 'terminated')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'terminated'
      })
    ])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('matches scoped SSH workspace bindings against raw relay leases', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('stores scoped SSH remote PTY leases as raw relay ids', async () => {
    const store = await createStore()

    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'ssh:ssh-1@@remote-pty',
      state: 'attached'
    })

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        targetId: 'ssh-1',
        ptyId: 'remote-pty',
        state: 'attached'
      })
    ])
  })

  it('rejects mismatched scoped SSH remote PTY lease ids on write paths', async () => {
    const store = await createStore()

    expect(() =>
      store.upsertSshRemotePtyLease({
        targetId: 'ssh-1',
        ptyId: 'ssh:ssh-2@@remote-pty',
        state: 'attached'
      })
    ).toThrow('belongs to SSH connection "ssh-2"')
  })

  it('updates SSH remote PTY leases when callers pass scoped app ids', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'attached'
    })

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'terminated')

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'terminated'
      })
    ])
  })

  it('clears workspace bindings when marking an SSH remote PTY lease expired', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'expired')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'expired'
      })
    ])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('removes SSH remote PTY leases when callers pass scoped app ids', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('clears workspace bindings before removing contextless SSH remote PTY leases', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('does not revive expired leases when marking a target detached', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'live-pty',
      state: 'attached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'expired-pty',
      state: 'expired'
    })

    store.markSshRemotePtyLeases('ssh-1', 'detached')

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'live-pty', state: 'detached' }),
        expect.objectContaining({ ptyId: 'expired-pty', state: 'expired' })
      ])
    )
  })

  // ── getAllWorktreeMeta ─────────────────────────────────────────────

  it('getAllWorktreeMeta returns all entries', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    const all = store.getAllWorktreeMeta()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['a'].displayName).toBe('A')
    expect(all['b'].displayName).toBe('B')
  })

  // ── removeWorktreeMeta ─────────────────────────────────────────────

  it('removeWorktreeMeta deletes a single entry', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    store.removeWorktreeMeta('a')
    expect(store.getWorktreeMeta('a')).toBeUndefined()
    expect(store.getWorktreeMeta('b')).toBeDefined()
  })

  it('stores and removes worktree lineage independently from metadata', async () => {
    const store = await createStore()
    const lineage = makeWorktreeLineage()

    store.setWorktreeMeta(lineage.worktreeId, { displayName: 'child' })
    store.setWorktreeLineage(lineage.worktreeId, lineage)

    expect(store.getWorktreeLineage(lineage.worktreeId)).toEqual(lineage)
    expect(store.getAllWorktreeLineage()).toEqual({ [lineage.worktreeId]: lineage })

    store.removeWorktreeLineage(lineage.worktreeId)

    expect(store.getWorktreeLineage(lineage.worktreeId)).toBeUndefined()
    expect(store.getWorktreeMeta(lineage.worktreeId)).toBeDefined()
  })

  it('removeWorktreeMeta deletes that worktree lineage entry', async () => {
    const store = await createStore()
    const lineage = makeWorktreeLineage()

    store.setWorktreeMeta(lineage.worktreeId, { displayName: 'child' })
    store.setWorktreeLineage(lineage.worktreeId, lineage)

    store.removeWorktreeMeta(lineage.worktreeId)

    expect(store.getWorktreeMeta(lineage.worktreeId)).toBeUndefined()
    expect(store.getWorktreeLineage(lineage.worktreeId)).toBeUndefined()
  })

  it('stores workspace lineage and removes it with the child worktree metadata', async () => {
    const store = await createStore()
    const lineage = makeWorkspaceLineage()

    store.setWorktreeMeta('r1::/path/child', { displayName: 'child' })
    store.setWorkspaceLineage(lineage)

    expect(store.getWorkspaceLineage(lineage.childWorkspaceKey)).toEqual(lineage)
    expect(store.getAllWorkspaceLineage()).toEqual({ [lineage.childWorkspaceKey]: lineage })

    store.removeWorktreeMeta('r1::/path/child')

    expect(store.getWorkspaceLineage(lineage.childWorkspaceKey)).toBeUndefined()
  })

  it('removeFolderWorkspace deletes child workspace lineage for that folder parent', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder parent'
    })
    const folderLineage = makeWorkspaceLineage({
      parentWorkspaceKey: folderWorkspaceKey(workspace.id)
    })
    const unrelatedLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey('r2::/other-child'),
      parentWorkspaceKey: folderWorkspaceKey('other-folder')
    })

    store.setWorkspaceLineage(folderLineage)
    store.setWorkspaceLineage(unrelatedLineage)

    store.removeFolderWorkspace(workspace.id)

    expect(store.getWorkspaceLineage(folderLineage.childWorkspaceKey)).toBeUndefined()
    expect(store.getWorkspaceLineage(unrelatedLineage.childWorkspaceKey)).toEqual(unrelatedLineage)
  })

  // ── Rolling backups (issue #1158) ──────────────────────────────────

  describe('rolling backups', () => {
    function backupFile(index: number): string {
      return `${dataFile()}.bak.${index}`
    }

    function readBackup(index: number): { repos: Repo[] } {
      return JSON.parse(readFileSync(backupFile(index), 'utf-8'))
    }

    function advanceMockedTime(advanceFn: () => void, ms: number): void {
      vi.setSystemTime(new Date(Date.now() + ms))
      advanceFn()
    }

    it('snapshots the just-written file to .bak.0 on the very first write', async () => {
      const s = await createStore()
      s.addRepo(makeRepo())
      s.flush()
      expect(existsSync(dataFile())).toBe(true)
      expect(existsSync(backupFile(0))).toBe(true)
      expect(readBackup(0).repos.map((r) => r.id)).toEqual(['r1'])
    })

    it('rotates older .bak.0 to .bak.1 when the interval elapses', async () => {
      vi.useFakeTimers()
      try {
        const first = await createStore()
        first.addRepo(makeRepo({ id: 'r1' }))
        first.flush()
        expect(readBackup(0).repos.map((r) => r.id)).toEqual(['r1'])

        vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))

        const second = await createStore()
        second.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))
        second.flush()

        const current = readDataFile() as { repos: Repo[] }
        expect(current.repos.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['r1', 'r2'])
        expect(readBackup(1).repos.map((r) => r.id)).toEqual(['r1'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps at most 5 rotating backups', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        for (let i = 0; i < 6; i++) {
          vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
          const s = await createStore()
          s.addRepo(makeRepo({ id: `gen-${i}`, path: `/gen-${i}` }))
          s.flush()
        }

        for (let i = 0; i < 5; i++) {
          expect(existsSync(backupFile(i))).toBe(true)
        }
        expect(existsSync(backupFile(5))).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not rotate more than once per hour', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'after-seed' }))
        store.flush()

        const bak0After1 = readBackup(0)
        expect(bak0After1.repos.map((r) => r.id).sort()).toEqual(['after-seed', 'seed'])

        advanceMockedTime(
          () => {
            store.addRepo(makeRepo({ id: 'within-hour', path: '/within' }))
            store.flush()
          },
          5 * 60 * 1000
        )

        const bak0After2 = readBackup(0)
        expect(bak0After2.repos.map((r) => r.id).sort()).toEqual(['after-seed', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not rotate on the async write path within the 1-hour window', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        const bak0AfterFirst = readBackup(0)
        expect(bak0AfterFirst.repos.map((r) => r.id).sort()).toEqual(['first-async', 'seed'])

        vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000))
        store.addRepo(makeRepo({ id: 'within-hour-async', path: '/within-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        const bak0AfterSecond = readBackup(0)
        expect(bak0AfterSecond.repos.map((r) => r.id).sort()).toEqual(['first-async', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('rotates on the async write path after the 1-hour window elapses', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['first-async', 'seed'])

        vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
        store.addRepo(makeRepo({ id: 'after-hour-async', path: '/after-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['after-hour-async', 'first-async', 'seed'])
        expect(existsSync(backupFile(1))).toBe(true)
        expect(
          readBackup(1)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['first-async', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    function writeBackup(index: number, data: unknown): void {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(backupFile(index), JSON.stringify(data, null, 2), 'utf-8')
    }

    it('recovers from .bak.0 when the primary file is corrupt', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt-json', 'utf-8')
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'recovered' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['recovered'])
    })

    it('falls through to .bak.1 when both primary and .bak.0 are corrupt', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt-json', 'utf-8')
      writeFileSync(backupFile(0), '{{also-corrupt', 'utf-8')
      writeBackup(1, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'from-bak1' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['from-bak1'])
    })

    it('falls back to defaults only when every backup is also unusable', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt', 'utf-8')
      for (let i = 0; i < 5; i++) {
        writeFileSync(backupFile(i), `{{slot-${i}-corrupt`, 'utf-8')
      }

      const store = await createStore()
      expect(store.getRepos()).toEqual([])
    })

    it('uses .bak.0 even when primary file is missing entirely', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'rescued' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['rescued'])
    })

    it('still recovers repos/worktrees from a backup with corrupt workspaceSession', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt', 'utf-8')
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'survives' })],
        worktreeMeta: {},
        settings: { theme: 'dark' },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: { activeRepoId: 12345 }
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['survives'])
      expect(store.getSettings().theme).toBe('dark')
    })
  })

  // ── Concurrent write serialization (issue #1158) ───────────────────

  describe('concurrent write serialization', () => {
    it('chains debounced writes via pendingWrite so they run sequentially', async () => {
      vi.useFakeTimers()
      try {
        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first' }))
        vi.advanceTimersByTime(300)
        store.addRepo(makeRepo({ id: 'second', path: '/second' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as { repos: Repo[] }
        expect(persisted.repos.map((r) => r.id).sort()).toEqual(['first', 'second'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ── Telemetry cohort migration ─────────────────────────────────────
  //
  // The migration keys on `existsSync(dataFile)` rather than field-based
  // inference because the `telemetry` field is new in this release: keying
  // on its presence would misclassify every pre-telemetry install as fresh,
  // silently flipping existing users to default-on and violating the social
  // contract they installed Orca under.

  it('classifies a truly fresh install as new-user cohort (file absent → optedIn=true)', async () => {
    // No data file written — truly fresh install of the telemetry release.
    const store = await createStore()
    const t = store.getSettings().telemetry
    expect(t).toBeDefined()
    expect(t!.existedBeforeTelemetryRelease).toBe(false)
    expect(t!.optedIn).toBe(true)
    expect(t!.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('classifies a pre-existing install as existing-user cohort (file present → optedIn=null)', async () => {
    // A pre-telemetry data file exists on disk with no telemetry block.
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo()],
      worktreeMeta: {},
      settings: { theme: 'dark' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    const t = store.getSettings().telemetry
    expect(t).toBeDefined()
    expect(t!.existedBeforeTelemetryRelease).toBe(true)
    expect(t!.optedIn).toBeNull()
    expect(t!.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    // Sibling migrations still run alongside the telemetry migration.
    expect(store.getSettings().theme).toBe('dark')
  })

  it('still classifies as existing-user cohort when the data file is corrupt', async () => {
    // Load-bearing: `fileExistedOnLoad` stays true even when the parse
    // throws, so the corrupt-file catch path must also apply the migration.
    // Otherwise a user whose `orca-data.json` got corrupted would be
    // silently opted in as if they were a fresh install.
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{{corrupt json', 'utf-8')
    const store = await createStore()
    const t = store.getSettings().telemetry
    expect(t).toBeDefined()
    expect(t!.existedBeforeTelemetryRelease).toBe(true)
    expect(t!.optedIn).toBeNull()
    expect(t!.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('preserves an already-migrated telemetry block on subsequent launches', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        telemetry: {
          optedIn: true,
          installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          existedBeforeTelemetryRelease: false
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().telemetry).toEqual({
      optedIn: true,
      installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      existedBeforeTelemetryRelease: false
    })
  })
})

describe('Store.migrateWorktreeIdentity', () => {
  const OLD = 'repo1::/ws/cunner'
  const NEW = 'repo1::/ws/worktree-creation-spinner'
  const OLD_WORKSPACE_KEY = worktreeWorkspaceKey(OLD)
  const NEW_WORKSPACE_KEY = worktreeWorkspaceKey(NEW)

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('moves meta, lineage, tabs, active pointers, and records the prior id', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner', linkedIssue: 42 })
    store.setWorktreeLineage(OLD, makeWorktreeLineage({ worktreeId: OLD }))
    store.setWorkspaceLineage(
      makeWorkspaceLineage({
        childWorkspaceKey: OLD_WORKSPACE_KEY,
        parentWorkspaceKey: folderWorkspaceKey('folder-parent')
      })
    )
    store.setWorkspaceLineage(
      makeWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey('repo1::/ws/child'),
        parentWorkspaceKey: OLD_WORKSPACE_KEY
      })
    )
    store.setWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorkspaceKey: OLD_WORKSPACE_KEY,
      activeWorktreeId: OLD,
      activeTabId: 'tab1',
      tabsByWorktree: { [OLD]: [makeTerminalTab({ id: 'tab1', worktreeId: OLD })] },
      activeWorktreeIdsOnShutdown: [OLD],
      openFilesByWorktree: {
        [OLD]: [
          { filePath: '/ws/cunner/a.ts', relativePath: 'a.ts', worktreeId: OLD, language: 'ts' }
        ]
      },
      activeFileIdByWorktree: { [OLD]: '/ws/cunner/a.ts' },
      browserTabsByWorktree: {
        [OLD]: [{ id: 'browser1', worktreeId: OLD, title: 'Browser', url: 'about:blank' }]
      },
      browserPagesByWorkspace: {
        browser1: [{ id: 'page1', workspaceId: 'browser1', worktreeId: OLD }]
      },
      activeBrowserTabIdByWorktree: { [OLD]: 'browser1' },
      activeTabTypeByWorktree: { [OLD]: 'browser' },
      activeTabIdByWorktree: { [OLD]: 'tab1' },
      unifiedTabs: { [OLD]: [{ id: 'unified1', worktreeId: OLD }] },
      tabGroups: {
        [OLD]: [{ id: 'group1', worktreeId: OLD, activeTabId: 'unified1', tabOrder: ['unified1'] }]
      },
      tabGroupLayouts: { [OLD]: { type: 'leaf', groupId: 'group1' } },
      activeGroupIdByWorktree: { [OLD]: 'group1' },
      lastVisitedAtByWorktreeId: { [OLD]: 123 },
      defaultTerminalTabsAppliedByWorktreeId: { [OLD]: true },
      sleepingAgentSessionsByPaneKey: {
        'tab1:leaf': {
          paneKey: 'tab1:leaf',
          tabId: 'tab1',
          worktreeId: OLD,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'Do work',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1
        }
      },
      terminalLayoutsByTabId: {}
    } as unknown as WorkspaceSessionState)
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'repo1',
        activeWorkspaceKey: OLD_WORKSPACE_KEY,
        activeWorktreeId: OLD,
        tabsByWorktree: { [OLD]: [makeTerminalTab({ id: 'host-tab', worktreeId: OLD })] },
        terminalLayoutsByTabId: {}
      },
      'runtime:env-a'
    )

    store.migrateWorktreeIdentity(OLD, NEW)

    expect(store.getWorktreeMeta(OLD)).toBeUndefined()
    const meta = store.getWorktreeMeta(NEW)
    expect(meta?.displayName).toBe('Cunner')
    expect(meta?.linkedIssue).toBe(42)
    expect(meta?.priorWorktreeIds).toEqual([OLD])

    expect(store.getWorktreeLineage(OLD)).toBeUndefined()
    expect(store.getWorktreeLineage(NEW)?.worktreeId).toBe(NEW)
    expect(store.getWorkspaceLineage(OLD_WORKSPACE_KEY)).toBeUndefined()
    expect(store.getWorkspaceLineage(NEW_WORKSPACE_KEY)?.childWorkspaceKey).toBe(NEW_WORKSPACE_KEY)
    expect(
      store.getWorkspaceLineage(worktreeWorkspaceKey('repo1::/ws/child'))?.parentWorkspaceKey
    ).toBe(NEW_WORKSPACE_KEY)

    // The live session's tab keeps its frozen ptyId but now belongs to the new id.
    expect(store.getWorktreeIdForTab('tab1')).toBe(NEW)
    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[OLD]).toBeUndefined()
    expect(session.tabsByWorktree[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.activeWorkspaceKey).toBe(NEW_WORKSPACE_KEY)
    expect(session.activeWorktreeIdsOnShutdown).toEqual([NEW])
    expect(session.openFilesByWorktree?.[OLD]).toBeUndefined()
    expect(session.openFilesByWorktree?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.activeFileIdByWorktree?.[NEW]).toBe('/ws/cunner/a.ts')
    expect(session.browserTabsByWorktree?.[OLD]).toBeUndefined()
    expect(session.browserTabsByWorktree?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.browserPagesByWorkspace?.browser1?.[0]?.worktreeId).toBe(NEW)
    expect(session.activeBrowserTabIdByWorktree?.[NEW]).toBe('browser1')
    expect(session.activeTabTypeByWorktree?.[NEW]).toBe('browser')
    expect(session.activeWorktreeId).toBe(NEW)
    expect(session.activeTabIdByWorktree?.[NEW]).toBe('tab1')
    expect(session.unifiedTabs?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.tabGroups?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.tabGroupLayouts?.[NEW]).toEqual({ type: 'leaf', groupId: 'group1' })
    expect(session.activeGroupIdByWorktree?.[NEW]).toBe('group1')
    expect(session.lastVisitedAtByWorktreeId?.[NEW]).toBe(123)
    expect(session.defaultTerminalTabsAppliedByWorktreeId?.[NEW]).toBe(true)
    expect(session.sleepingAgentSessionsByPaneKey?.['tab1:leaf']?.worktreeId).toBe(NEW)

    const hostSession = store.getWorkspaceSession('runtime:env-a')
    expect(hostSession.tabsByWorktree[OLD]).toBeUndefined()
    expect(hostSession.tabsByWorktree[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(hostSession.activeWorkspaceKey).toBe(NEW_WORKSPACE_KEY)
  })

  it('rewrites parentWorktreeId back-references in other lineage entries', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner' })
    const CHILD = 'repo1::/ws/child'
    store.setWorktreeLineage(
      CHILD,
      makeWorktreeLineage({ worktreeId: CHILD, parentWorktreeId: OLD })
    )

    store.migrateWorktreeIdentity(OLD, NEW)

    expect(store.getWorktreeLineage(CHILD)?.parentWorktreeId).toBe(NEW)
  })

  it('accumulates prior ids across chained renames', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner' })
    store.migrateWorktreeIdentity(OLD, NEW)
    const NEWER = 'repo1::/ws/final-name'
    store.migrateWorktreeIdentity(NEW, NEWER)
    expect(store.getWorktreeMeta(NEWER)?.priorWorktreeIds).toEqual([OLD, NEW])
  })

  it('is a no-op when the ids match', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner' })
    store.migrateWorktreeIdentity(OLD, OLD)
    expect(store.getWorktreeMeta(OLD)?.priorWorktreeIds).toBeUndefined()
  })
})

describe('Store host-partitioned workspace sessions', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const makeHostSession = (activeRepoId: string): WorkspaceSessionState => ({
    ...getDefaultWorkspaceSession(),
    activeRepoId
  })

  it('migrates a legacy workspaceSession blob into the local partition', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('legacy-repo')
    })

    const store = await createStore()

    // The legacy blob is the 'local' partition; an explicit/default hostId reads it.
    expect(store.getWorkspaceSession().activeRepoId).toBe('legacy-repo')
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('legacy-repo')
    // No data was moved, so a downgrade still finds the legacy field intact.
    store.flush()
    const persisted = readDataFile() as { workspaceSession?: { activeRepoId?: string } }
    expect(persisted.workspaceSession?.activeRepoId).toBe('legacy-repo')
  })

  it('is idempotent: re-loading already-partitioned state preserves all hosts', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('local-repo'),
      workspaceSessionsByHostId: {
        'runtime:env-a': makeHostSession('runtime-repo'),
        'ssh:host-b': makeHostSession('ssh-repo')
      }
    })

    const readSessionPartitions = (): unknown => {
      const data = readDataFile() as {
        workspaceSession?: unknown
        workspaceSessionsByHostId?: unknown
      }
      return {
        workspaceSession: data.workspaceSession,
        workspaceSessionsByHostId: data.workspaceSessionsByHostId
      }
    }

    const first = await createStore()
    first.flush()
    const afterFirst = readSessionPartitions()

    const second = await createStore()
    second.flush()
    const afterSecond = readSessionPartitions()

    // Re-running the partition migration must not move or reshape any host.
    expect(afterSecond).toEqual(afterFirst)
    expect(second.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('runtime-repo')
    expect(second.getWorkspaceSession('ssh:host-b').activeRepoId).toBe('ssh-repo')
    expect(second.getWorkspaceSession('local').activeRepoId).toBe('local-repo')
  })

  it('drops a stray "local" key in workspaceSessionsByHostId in favor of the legacy blob', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('canonical-local'),
      workspaceSessionsByHostId: {
        local: makeHostSession('shadow-local')
      }
    })

    const store = await createStore()

    expect(store.getWorkspaceSession('local').activeRepoId).toBe('canonical-local')
  })

  it('isolates writes: setting host A does not mutate host B or local', async () => {
    const store = await createStore()

    store.setWorkspaceSession(makeHostSession('repo-local'), 'local')
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')
    store.setWorkspaceSession(makeHostSession('repo-b'), 'runtime:env-b')

    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
    expect(store.getWorkspaceSession('runtime:env-b').activeRepoId).toBe('repo-b')

    // Overwriting host A leaves host B and local untouched.
    store.setWorkspaceSession(makeHostSession('repo-a2'), 'runtime:env-a')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a2')
    expect(store.getWorkspaceSession('runtime:env-b').activeRepoId).toBe('repo-b')
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
  })

  it('patches a single host partition without touching the others', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-local'), 'local')
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')

    store.patchWorkspaceSession({ activeTabId: 'tab-a' }, 'runtime:env-a')

    expect(store.getWorkspaceSession('runtime:env-a').activeTabId).toBe('tab-a')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
    // Local was never given that tab id.
    expect(store.getWorkspaceSession('local').activeTabId).toBeNull()
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
  })

  it('defaults an omitted hostId to the local partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')

    // No hostId → local, which is still empty/default and unaffected by host A.
    store.setWorkspaceSession(makeHostSession('repo-local'))
    expect(store.getWorkspaceSession().activeRepoId).toBe('repo-local')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
  })

  it('round-trips host partitions through disk', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
  })

  it('drops a corrupt host partition to defaults without failing the others', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSessionsByHostId: {
        'runtime:good': makeHostSession('good-repo'),
        // activeRepoId must be string|null; a number fails the zod parse.
        'runtime:bad': { ...makeHostSession('x'), activeRepoId: 123 }
      }
    })

    const store = await createStore()

    expect(store.getWorkspaceSession('runtime:good').activeRepoId).toBe('good-repo')
    // Bad partition collapses to defaults rather than poisoning the map.
    expect(store.getWorkspaceSession('runtime:bad').activeRepoId).toBeNull()
  })
})
