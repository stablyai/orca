import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isTerminalLeafId, makePaneKey } from '../shared/stable-pane-id'
import { SshConnectionStore } from './ssh/ssh-connection-store'
import { LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../shared/ssh-types'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

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
  // ── 2. Load from existing valid file ─────────────────────────────────

  it('reads repos from an existing data file', async () => {
    // Why: hydration serves the persisted username without spawning git/gh (issue #7225); resolution happens in background enrichment.
    const repo = makeRepo({ gitUsername: 'testuser' })
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
          relayGracePeriodSeconds: LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
          remoteWorkspaceSyncEnabled: true,
          remoteWorkspaceSyncGracePeriodSeconds: 0
        },
        {
          id: 'ssh-form-default-relay',
          label: 'Form-default relay',
          host: 'form-default.example.com',
          port: 22,
          username: 'dev',
          relayGracePeriodSeconds: LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
        }
      ]
    })

    const store = await createStore()
    const targets = store.getSshTargets()

    expect(targets[0]).not.toHaveProperty('relayGracePeriodSeconds')
    expect(targets[1].relayGracePeriodSeconds).toBe(0)
    expect(targets[2].relayGracePeriodSeconds).toBe(0)
    expect(targets[3].relayGracePeriodSeconds).toBe(0)
    expect(targets[4]).not.toHaveProperty('relayGracePeriodSeconds')
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
    expect(persisted.sshTargets?.[4]).not.toHaveProperty('relayGracePeriodSeconds')
    for (const target of persisted.sshTargets ?? []) {
      expect(target).not.toHaveProperty('remoteWorkspaceSyncEnabled')
      expect(target).not.toHaveProperty('remoteWorkspaceSyncGracePeriodSeconds')
    }
  })

  it('drops the legacy SSH relay default when updating targets', async () => {
    const store = await createStore()
    store.addSshTarget({
      id: 'ssh-update-legacy-default',
      label: 'Update legacy default',
      host: 'update-default.example.com',
      port: 22,
      username: 'dev'
    })

    const updated = store.updateSshTarget('ssh-update-legacy-default', {
      relayGracePeriodSeconds: LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
    })

    expect(updated).not.toHaveProperty('relayGracePeriodSeconds')
    expect(store.getSshTarget('ssh-update-legacy-default')).not.toHaveProperty(
      'relayGracePeriodSeconds'
    )

    store.flush()
    const persisted = readDataFile() as { sshTargets?: Record<string, unknown>[] }
    const onDisk = persisted.sshTargets?.find((t) => t.id === 'ssh-update-legacy-default')
    expect(onDisk).not.toHaveProperty('relayGracePeriodSeconds')
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

    // normalizeSshTarget must not strip `source` on update and the new port must take effect (persistence-layer guard for #4684 item #1).
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

  it('persists only explicit SSH connection reuse opt-outs', async () => {
    const store = await createStore()
    store.addSshTarget({
      id: 'ssh-reuse-default',
      label: 'Default reuse',
      host: 'default.example.com',
      port: 22,
      username: 'dev',
      systemSshConnectionReuse: true
    })
    store.addSshTarget({
      id: 'ssh-reuse-off',
      label: 'Reuse disabled',
      host: 'legacy.example.com',
      port: 22,
      username: 'dev',
      systemSshConnectionReuse: false
    })

    expect(store.getSshTarget('ssh-reuse-default')).not.toHaveProperty('systemSshConnectionReuse')
    expect(store.getSshTarget('ssh-reuse-off')?.systemSshConnectionReuse).toBe(false)

    store.flush()
    const persistedBeforeUpdate = readDataFile() as { sshTargets?: Record<string, unknown>[] }
    const defaultTarget = persistedBeforeUpdate.sshTargets?.find(
      (t) => t.id === 'ssh-reuse-default'
    )
    const disabledTarget = persistedBeforeUpdate.sshTargets?.find((t) => t.id === 'ssh-reuse-off')
    expect(defaultTarget).not.toHaveProperty('systemSshConnectionReuse')
    expect(disabledTarget?.systemSshConnectionReuse).toBe(false)

    const updated = store.updateSshTarget('ssh-reuse-off', { systemSshConnectionReuse: undefined })
    expect(updated).not.toHaveProperty('systemSshConnectionReuse')
    store.flush()
    const persisted = readDataFile() as { sshTargets?: Record<string, unknown>[] }
    const updatedTarget = persisted.sshTargets?.find((t) => t.id === 'ssh-reuse-off')
    expect(updatedTarget).not.toHaveProperty('systemSshConnectionReuse')
  })

  it('drops retired per-target SSH terminal source-credit selections', async () => {
    const store = await createStore()
    store.addSshTarget({
      id: 'ssh-source-credit-on',
      label: 'Noisy build host',
      host: 'build.example.com',
      port: 22,
      username: 'dev',
      experimentalPtySourceCreditV1: true
    } as never)

    expect(store.getSshTarget('ssh-source-credit-on')).not.toHaveProperty(
      'experimentalPtySourceCreditV1'
    )
    store.flush()
    const persisted = readDataFile() as { sshTargets?: Record<string, unknown>[] }
    const target = persisted.sshTargets?.find((entry) => entry.id === 'ssh-source-credit-on')
    expect(target).not.toHaveProperty('experimentalPtySourceCreditV1')
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
    // Rotated port: upsert updates the same target in place and normalizeSshTarget must keep `source` (no false re-derive into a permanently-dirty state).
    sshConfigHostsToTargetsMock.mockReturnValue(candidate(2222, 'ssh-cfg-2'))
    const changed = sshStore.importFromSshConfig()
    expect(changed).toHaveLength(1)
    expect(changed[0]?.port).toBe(2222)
    expect(changed[0]?.source).toBe('ssh-config')

    // A third identical sync is a no-op — repeated auto-sync on every pane open writes nothing.
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
      repos: [makeRepo({ id: 'repo1', path: '/repo1' })],
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
      repos: [makeRepo({ id: 'repo1', path: '/repo1' })],
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
})
