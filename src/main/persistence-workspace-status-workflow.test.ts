import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { testState, createStore, writeDataFile, readDataFile } from './persistence-test-harness'
import {
  REORDERED_DEFAULT_WORKSPACE_STATUSES,
  REORDERED_DONE_DEFAULT_WORKSPACE_STATUSES,
  LEGACY_DEFAULT_WORKSPACE_STATUSES,
  WORKFLOW_DEFAULT_WORKSPACE_STATUSES
} from './persistence-workspace-status-fixtures'

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
    // Why: the legacy-recent→smart migration must gate on the raw persisted value, not the normalized default, or fresh installs get mis-migrated to 'smart'.
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

  it('preserves workflows above 20 statuses across load, write, and restart', async () => {
    const imported = Array.from({ length: 21 }, (_, index) => ({
      id: `state-${index + 1}`,
      label: `State ${index + 1}`
    })).toReversed()
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { workspaceStatuses: imported },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().workspaceStatuses?.map((status) => status.id)).toEqual(
      imported.map((status) => status.id)
    )

    const authored = Array.from({ length: 64 }, (_, index) => ({
      id: `final-${String(index + 1).padStart(3, '0')}`,
      label: `Final ${index + 1}`
    })).toReversed()
    store.updateUI({ workspaceStatuses: authored })
    store.flush()

    expect(store.getUI().workspaceStatuses?.map((status) => status.id)).toEqual(
      authored.map((status) => status.id)
    )
    expect(
      (readDataFile() as PersistedState).ui.workspaceStatuses?.map((status) => status.id)
    ).toEqual(authored.map((status) => status.id))

    const restarted = await createStore()
    expect(restarted.getUI().workspaceStatuses?.map((status) => status.id)).toEqual(
      authored.map((status) => status.id)
    )
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
      'todo',
      'in-progress',
      'in-review',
      'completed'
    ])
    expect(ui.workspaceStatuses?.at(-1)?.label).toBe('Done')
    expect(ui._workspaceStatusesDefaultOrderMigrated).toBe(true)
    expect(ui._workspaceStatusesDefaultWorkflowMigrated).toBe(true)

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.ui._workspaceStatusesDefaultOrderMigrated).toBe(true)
    expect(persisted.ui._workspaceStatusesReorderedDefaultRepaired).toBe(true)
    expect(persisted.ui._workspaceStatusesDefaultWorkflowMigrated).toBe(true)
    expect(persisted.ui._workspaceStatusesDefaultVisualsMigrated).toBe(true)
    expect(persisted.ui.workspaceStatuses?.map((status) => status.id)).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'completed'
    ])
    expect(persisted.ui.workspaceStatuses?.at(-1)?.label).toBe('Done')
  })

  it('repairs the known-bad reordered default statuses after old migration flags are set', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        workspaceStatuses: REORDERED_DONE_DEFAULT_WORKSPACE_STATUSES,
        _workspaceStatusesDefaultOrderMigrated: true,
        _workspaceStatusesDefaultWorkflowMigrated: true,
        _workspaceStatusesDefaultVisualsMigrated: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().workspaceStatuses?.map((status) => status.id)).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'completed'
    ])
    expect(store.getUI().workspaceStatuses?.at(-1)?.label).toBe('Done')
    expect(store.getUI()._workspaceStatusesReorderedDefaultRepaired).toBe(true)
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
        _workspaceStatusesReorderedDefaultRepaired: true,
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
})
