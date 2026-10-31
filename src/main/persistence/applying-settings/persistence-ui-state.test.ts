import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../shared/workspace-cleanup-browse-state'
import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  readPersistedStateJson,
  testState,
  dataFile,
  writeDataFile,
  readDataFile
} from '../persistence-test-harness'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
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
  }
}))

let hasCreatedStoreInCase = false

async function createStore() {
  if (hasCreatedStoreInCase) {
    vi.resetModules()
  }
  const { setSecretStore } = await import('../../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    },
    describeProtectionGap: () => null
  })
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  const { Store } = await import('../loading-store/store')
  const { initDataPath } = await import('../loading-store/user-data-path')
  // Reinstall this test’s userData path after resetModules before initializing Store.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    hasCreatedStoreInCase = false
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('defaults new users to compact status bar usage', async () => {
    const store = await createStore()
    expect(store.getUI().statusBarUsageMode).toBe('compact')
  })

  it.each([undefined, null, 'expanded'])(
    'normalizes saved status bar usage mode %j to compact',
    async (value) => {
      const state = getDefaultPersistedState(testState.dir)
      if (value === undefined) {
        delete state.ui.statusBarUsageMode
      } else {
        Reflect.set(state.ui, 'statusBarUsageMode', value)
      }
      writeDataFile(state)

      const store = await createStore()
      expect(store.getUI().statusBarUsageMode).toBe('compact')
      store.updateUI({ sidebarWidth: 400 })
      expect(store.getUI().statusBarUsageMode).toBe('compact')
    }
  )

  it.each(['verbose', 'compact'] as const)('preserves saved %s usage mode', async (mode) => {
    const store = await createStore()
    store.updateUI({ statusBarUsageMode: mode })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getUI().statusBarUsageMode).toBe(mode)
    reloaded.updateUI({ sidebarWidth: 400 })
    expect(reloaded.getUI().statusBarUsageMode).toBe(mode)
  })

  it('moves the legacy host scope with a written host list, so "all hosts" sticks', async () => {
    const store = await createStore()
    store.updateUI({ workspaceHostScope: 'ssh:box', visibleWorkspaceHostIds: ['ssh:box'] })

    store.updateUI({ visibleWorkspaceHostIds: null })
    expect(store.getUI()).toMatchObject({
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all'
    })
    store.updateUI({ visibleWorkspaceHostIds: ['ssh:box'] })
    expect(store.getUI().workspaceHostScope).toBe('ssh:box')
    store.updateUI({ visibleWorkspaceHostIds: ['local', 'ssh:box'] })
    expect(store.getUI().workspaceHostScope).toBe('ssh:box')
    store.updateUI({ sidebarWidth: 300 })
    expect(store.getUI().workspaceHostScope).toBe('ssh:box')
  })

  it('updateUI merges partial updates', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 400 })
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(400)
    expect(ui.groupBy).toBe('repo')
    expect(ui.dismissedUpdateVersion).toBeNull()
  })

  it.each([false, true])(
    'restores sidebarOpen=%s from disk without changing the right sidebar',
    async (sidebarOpen) => {
      const store = await createStore()
      store.updateUI({ sidebarOpen, rightSidebarOpen: false })
      store.flush()

      const reloaded = await createStore()
      expect(reloaded.getUI().sidebarOpen).toBe(sidebarOpen)
      expect(reloaded.getUI().rightSidebarOpen).toBe(false)
    }
  )

  it('round-trips and normalizes the host-qualified manual repo order', async () => {
    const store = await createStore()
    store.updateUI({
      manualRepoOrder: [
        { hostId: 'runtime:node-b', repoId: 'shared' },
        { hostId: 'bogus', repoId: 'ignored' },
        { hostId: 'runtime:node-b', repoId: 'shared' },
        { hostId: 'local', repoId: 'alpha' }
      ] as never
    })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getUI().manualRepoOrder).toEqual([
      { hostId: 'runtime:node-b', repoId: 'shared' },
      { hostId: 'local', repoId: 'alpha' }
    ])
  })

  // Paired-client updates omit local ordering fields; omission must preserve the desktop’s own values.
  it('updateUI preserves the manual repo and host-section order when an update omits them', async () => {
    const store = await createStore()
    store.updateUI({
      manualRepoOrder: [
        { hostId: 'local', repoId: 'alpha' },
        { hostId: 'ssh:box', repoId: 'bravo' }
      ] as never,
      workspaceHostOrder: ['ssh:box', 'local'] as never
    })

    store.updateUI({ sidebarWidth: 400 })

    expect(store.getUI().manualRepoOrder).toEqual([
      { hostId: 'local', repoId: 'alpha' },
      { hostId: 'ssh:box', repoId: 'bravo' }
    ])
    expect(store.getUI().workspaceHostOrder).toEqual(['ssh:box', 'local'])
    expect(store.getUI().sidebarWidth).toBe(400)
  })

  it('updateUI persists sanitized per-worktree explorer roots', async () => {
    const store = await createStore()
    store.updateUI({
      explorerDisplayRootByWorktree: {
        'repo-1::/repo': '/',
        'repo-2::/repo': 'packages/app',
        // @ts-expect-error Deliberately malformed input exercises runtime sanitization.
        'repo-3::/repo': false,
        // @ts-expect-error Deliberately malformed prototype key exercises runtime sanitization.
        constructor: false
      }
    })

    expect(store.getUI().explorerDisplayRootByWorktree).toEqual({
      'repo-1::/repo': '/',
      'repo-2::/repo': 'packages/app'
    })
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

  it('updateUI survives a throwing UI listener so the shutdown checkpoint is not vetoed', async () => {
    const store = await createStore()
    const laterListener = vi.fn()
    store.onUIChanged(() => {
      throw new TypeError('Object has been destroyed')
    })
    store.onUIChanged(laterListener)

    expect(() => store.updateUI({ sidebarWidth: 321 })).not.toThrow()
    expect(store.getUI().sidebarWidth).toBe(321)
    expect(laterListener).toHaveBeenCalledWith(expect.objectContaining({ sidebarWidth: 321 }))
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
      vi.advanceTimersByTime(1000)
      await store.waitForPendingWrite()
      const persistedBefore = readPersistedStateJson(dataFile())
      const writes: (readonly string[] | undefined)[] = []
      store.onStateWritten((domains) => writes.push(domains))
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
      vi.advanceTimersByTime(1000)
      await store.waitForPendingWrite()

      expect(notifications).toEqual([])
      expect(writes).toEqual([])
      expect(readPersistedStateJson(dataFile())).toBe(persistedBefore)
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

  it('updateUI preserves browse state when a legacy peer publishes dismissals only', async () => {
    const store = await createStore()
    const browse = createDefaultWorkspaceCleanupBrowseState()
    browse.filters.query = 'stale'

    store.updateUI({ workspaceCleanup: { dismissals: {}, browse } })
    store.updateUI({
      workspaceCleanup: {
        dismissals: {
          'wt-1': {
            worktreeId: 'wt-1',
            dismissedAt: 1700000000000,
            fingerprint: 'fp-1',
            classifierVersion: 2
          }
        }
      }
    })

    expect(store.getUI().workspaceCleanup?.browse).toEqual(browse)
    expect(store.getUI().workspaceCleanup?.dismissals).toHaveProperty('wt-1')
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

    // Convert the saved logarithmic zoom to a factor, then snap to Chrome’s 125% preset.
    store.updateUI({ browserDefaultZoomLevel: 1.26 })

    expect(1.2 ** (store.getUI().browserDefaultZoomLevel ?? 0)).toBeCloseTo(1.25)
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

  // Preserve sealed relay-era recovery records for downgrades.
  const legacyRecovery = {
    targetId: 'ssh-1',
    clientInstanceId: 'client-1',
    serverBuildId: 'relay-build-1',
    clientGeneration: 3,
    ownerGeneration: 5,
    ownerLease: 'secret-owner-lease',
    outputFlowControl: { version: 1, windowSu: 256 * 1024 }
  }
  const sealedOwnerLease = (lease: string) =>
    Buffer.from(`encrypted:${lease}`, 'utf-8').toString('base64')

  it('re-seals SSH PTY consumer ownership on every save so a downgrade can recover it', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      sshPtyConsumerRecoveries: [
        { ...legacyRecovery, ownerLease: sealedOwnerLease(legacyRecovery.ownerLease) }
      ]
    })
    const store = await createStore()
    store.updateUI({ sidebarWidth: 301 })
    store.flush()

    expect(readDataFile()).toHaveProperty('sshPtyConsumerRecoveries', [
      { ...legacyRecovery, ownerLease: sealedOwnerLease(legacyRecovery.ownerLease) }
    ])

    const reloaded = await createStore()
    reloaded.updateUI({ sidebarWidth: 302 })
    reloaded.flush()
    expect(readDataFile()).toHaveProperty('sshPtyConsumerRecoveries', [
      { ...legacyRecovery, ownerLease: sealedOwnerLease(legacyRecovery.ownerLease) }
    ])
  })

  it('drops decrypted SSH PTY owner leases that exceed the relay protocol bound', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      sshPtyConsumerRecoveries: [
        { ...legacyRecovery, ownerLease: sealedOwnerLease('x'.repeat(513)) }
      ]
    })

    const store = await createStore()
    store.updateUI({ sidebarWidth: 301 })
    store.flush()

    expect(readDataFile()).toHaveProperty('sshPtyConsumerRecoveries', [])
  })

  it('removes persisted SSH PTY consumer ownership with its target', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      sshTargets: [
        { id: 'ssh-1', label: 'SSH 1', host: 'example.test', port: 22, username: 'orca' }
      ],
      sshPtyConsumerRecoveries: [
        { ...legacyRecovery, ownerLease: sealedOwnerLease(legacyRecovery.ownerLease) }
      ]
    })
    const store = await createStore()

    store.removeSshTarget('ssh-1')
    store.flush()

    expect(readDataFile()).toHaveProperty('sshPtyConsumerRecoveries', [])
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
})
