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
  ProjectGroup,
  Repo,
  TerminalPaneLayoutNode,
  TerminalTab,
  WorktreeLineage,
  WorkspaceSessionState
} from '../shared/types'
import { isTerminalLeafId, makePaneKey } from '../shared/stable-pane-id'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import { MAX_BROWSER_HISTORY_ENTRIES } from '../shared/workspace-session-browser-history'
import {
  getDefaultWorkspaceSession,
  ONBOARDING_FINAL_STEP,
  ONBOARDING_FLOW_VERSION
} from '../shared/constants'
import { SshConnectionStore } from './ssh/ssh-connection-store'

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

  it('keeps current onboarding progress marked as the four-step flow', async () => {
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
    expect(onboarding.lastCompletedStep).toBe(4)
  })

  it.each([
    [{ outcome: 'completed', lastCompletedStep: 7 }, 'completed', 4],
    [{ closedAt: null, outcome: 'dismissed', lastCompletedStep: 2 }, 'dismissed', 2],
    [{ closedAt: 'invalid', outcome: 'completed', lastCompletedStep: 7 }, 'completed', 4]
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

  it('updateUI restores fixed card properties from direct UI writes', async () => {
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

  // ── inline-agents card-property migration ──────────────────────────
  //
  // Why: 'inline-agents' was added to DEFAULT_WORKTREE_CARD_PROPERTIES after
  // the inline agents feature shipped default-on. Existing users had
  // worktreeCardProperties persisted without the new entry, so the
  // defaults-merge in load() wouldn't reach them and the inline agent list
  // stayed hidden after upgrade. The migration appends 'inline-agents' once
  // for every user and sets a flag so a later deliberate uncheck from the
  // Workspaces view options menu sticks across restarts.

  it('adds inline-agents to persisted cardProps on first load after upgrade', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment']
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI().worktreeCardProperties).toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).toContain('ports')
    expect(store.getUI()._inlineAgentsDefaultedForExperiment).toBe(true)
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
    expect(store.getUI()._expandedWorktreeCardPropertiesDefaulted).toBe(true)
  })

  it('adds inline-agents for users who launched a prior RC with the experiment off', async () => {
    // Why: the legacy flag _inlineAgentsDefaultedForExperiment was stamped
    // unconditionally on every prior load, so opt-out RC users already have
    // it set to true on disk. The default-on migration must NOT be gated on
    // that legacy flag — it must use the new _inlineAgentsDefaultedForAllUsers
    // flag instead. Without this test, the regression would re-appear if
    // anyone tried to "consolidate" the two flags.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI().worktreeCardProperties).toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).toContain('ports')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
    expect(store.getUI()._expandedWorktreeCardPropertiesDefaulted).toBe(true)
  })

  it('respects a deliberate post-migration uncheck', async () => {
    // Why: once migrated, an empty-of-inline-agents array is treated as a
    // user choice — not a legacy pre-migration state — so we must not
    // re-add it on every subsequent launch.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForAllUsers: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
    expect(store.getUI().worktreeCardProperties).toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).toContain('ports')
  })

  it('adds split-out default card properties without duplicating inline-agents', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
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
    const props = store.getUI().worktreeCardProperties
    expect(props.filter((p) => p === 'inline-agents')).toHaveLength(1)
    expect(props.filter((p) => p === 'linear-issue')).toHaveLength(1)
    expect(props.filter((p) => p === 'ports')).toHaveLength(1)
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
  })

  it('adds split-out default card properties when loading old user choices', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['inline-agents'],
        _inlineAgentsDefaultedForAllUsers: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ports',
      'inline-agents'
    ])
  })

  it('keeps Agent activity opt-out while adding split-out default card properties', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: [],
        _inlineAgentsDefaultedForAllUsers: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread', 'ports'])
  })

  it('preserves deliberate Linear and Ports opt-outs after split-out migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).not.toContain('ports')
  })

  it('preserves a deliberate uncheck from the experimental-toggle era (Case B)', async () => {
    // Why: a user who turned the experiment on and then deliberately
    // unchecked 'inline-agents' from the sidebar options menu has the same
    // on-disk shape as a never-touched user (legacy flag true, no
    // 'inline-agents' in worktreeCardProperties). The migration discriminates
    // them via the deprecated experimentalAgentDashboard value still riding
    // on disk. Without this discriminator, the deliberate uncheck would be
    // silently overridden on first load after upgrade.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: true },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
    expect(store.getUI().worktreeCardProperties).toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).toContain('ports')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
  })

  it('Case B preservation is durable across restarts', async () => {
    // Why: once the new flag is stamped, the discriminator is no longer
    // consulted. Subsequent loads must leave the deliberate uncheck intact
    // even if a future settings-write code path were to strip the deprecated
    // experimentalAgentDashboard key from disk.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: true },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true,
        _inlineAgentsDefaultedForAllUsers: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
    expect(store.getUI().worktreeCardProperties).toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).toContain('ports')
  })

  it('lapsed Case B (experiment off at upgrade time) re-adds inline-agents', async () => {
    // Why: documented limitation. A user who turned experiment on, unchecked,
    // then turned the experiment off again before upgrading has
    // experimentalAgentDashboard: false on disk. The discriminator only sees
    // the most recent value, so they fall into the Case C path. They re-uncheck
    // once and it sticks (new flag stamps). This test locks the limitation in
    // so a future "fix" doesn't accidentally regress something else.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI().worktreeCardProperties).toContain('linear-issue')
    expect(store.getUI().worktreeCardProperties).toContain('ports')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
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
