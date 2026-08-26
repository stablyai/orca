import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { getDefaultPersistedState } from '../shared/constants'
import { createDefaultWorkspaceCleanupBrowseState } from '../shared/workspace-cleanup-browse-state'
import {
  testState,
  dataFile,
  writeDataFile,
  readDataFile,
  makeRepo
} from './persistence-test-harness'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

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
  }
}))

async function createStore() {
  vi.resetModules()
  const { setSecretStore } = await import('../shared/secret-store')
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
  const { Store, initDataPath } = await import('./persistence')
  // Why here: userData resolves through AppEnvironment, and this must point at this
  // file's temp dir rather than the global fake's shared one, after resetModules.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return new Store()
}

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
  // ── UI state ───────────────────────────────────────────────────────

  it('updateUI merges partial updates', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 400 })
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(400)
    expect(ui.groupBy).toBe('repo') // default preserved
    expect(ui.dismissedUpdateVersion).toBeNull()
  })

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

  // The RPC now strips manualRepoOrder, so every paired-client ui.set reaches the store without
  // the key. Absent has to mean preserve: if it read as clear, the strip would erase the desktop's
  // order on the first unrelated setting a phone or web client changes.
  // Absent-means-preserve is what makes the pairing-local strip safe: a client's ui.set arrives
  // without these fields, so the desktop's own values must survive the update.
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
      vi.advanceTimersByTime(1000)
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
      vi.advanceTimersByTime(1000)
      await store.waitForPendingWrite()

      expect(notifications).toEqual([])
      expect(readFileSync(dataFile(), 'utf-8')).toBe(persistedBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes compact JSON (no pretty-print indentation) that round-trips via JSON.parse', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'compact-repo', path: '/compact/repo' }))
    store.updateUI({ sidebarWidth: 321 })
    store.flush()

    const raw = readFileSync(dataFile(), 'utf-8')
    // Compact payload: no newline-plus-indentation from JSON.stringify(_, null, 2).
    expect(raw).not.toMatch(/\n\s+"/)
    const parsed = JSON.parse(raw) as PersistedState
    expect(parsed.repos).toContainEqual(
      expect.objectContaining({ id: 'compact-repo', path: '/compact/repo' })
    )
    expect(parsed.ui.sidebarWidth).toBe(321)
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

  it('durably encrypts SSH PTY consumer ownership for process restart recovery', async () => {
    const store = await createStore()
    store.setGitHubCache({ pr: { 'o/r#1': { fetchedAt: 1 } as never }, issue: {} })
    await store.upsertSshPtyConsumerRecovery({
      targetId: 'ssh-1',
      clientInstanceId: 'client-1',
      serverBuildId: 'relay-build-1',
      clientGeneration: 3,
      ownerGeneration: 5,
      ownerLease: 'secret-owner-lease',
      outputFlowControl: { version: 1, windowSu: 256 * 1024 }
    })

    const persisted = readDataFile() as {
      sshPtyConsumerRecoveries: { ownerLease: string }[]
    }
    expect(persisted.sshPtyConsumerRecoveries[0]?.ownerLease).not.toBe('secret-owner-lease')
    expect(existsSync(join(testState.dir, 'orca-github-cache.json'))).toBe(false)

    const reloaded = await createStore()
    expect(reloaded.getSshPtyConsumerRecovery('ssh-1')).toEqual({
      targetId: 'ssh-1',
      clientInstanceId: 'client-1',
      serverBuildId: 'relay-build-1',
      clientGeneration: 3,
      ownerGeneration: 5,
      ownerLease: 'secret-owner-lease',
      outputFlowControl: { version: 1, windowSu: 256 * 1024 }
    })
  })

  it('drops decrypted SSH PTY owner leases that exceed the relay protocol bound', async () => {
    const oversizedLease = 'x'.repeat(513)
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      sshPtyConsumerRecoveries: [
        {
          targetId: 'ssh-1',
          clientInstanceId: 'client-1',
          serverBuildId: 'relay-build-1',
          clientGeneration: 3,
          ownerGeneration: 5,
          ownerLease: Buffer.from(`encrypted:${oversizedLease}`, 'utf-8').toString('base64')
        }
      ]
    })

    const store = await createStore()

    expect(store.getSshPtyConsumerRecovery('ssh-1')).toBeNull()
  })

  it('removes persisted SSH PTY consumer ownership with its target', async () => {
    const store = await createStore()
    store.addSshTarget({
      id: 'ssh-1',
      label: 'SSH 1',
      host: 'example.test',
      port: 22,
      username: 'orca'
    })
    await store.upsertSshPtyConsumerRecovery({
      targetId: 'ssh-1',
      clientInstanceId: 'client-1',
      serverBuildId: 'relay-build-1',
      clientGeneration: 3,
      ownerGeneration: 5,
      ownerLease: 'secret-owner-lease'
    })

    store.removeSshTarget('ssh-1')

    expect(store.getSshPtyConsumerRecovery('ssh-1')).toBeNull()
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
