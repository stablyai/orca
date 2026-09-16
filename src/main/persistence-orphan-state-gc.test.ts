import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { toSshExecutionHostId } from '../shared/execution-host'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
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

vi.mock('./telemetry/client', () => ({ track: trackMock }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

describe('Store orphan-state GC on load', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('sweeps worktreeMeta for a repo id absent from repos even when its path is live or its host is remote', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const meta = (extra: Record<string, unknown> = {}) => ({
      displayName: '',
      comment: '',
      lastActivityAt: OLD,
      ...extra
    })
    const livePath = testState.dir
    const liveKey = `live-repo::${livePath}`
    const orphanSamePathKey = `orphan-repo::${livePath}`
    const orphanRemoteHostKey = 'orphan-repo::/home/tiger/gone'
    writeDataFile({
      repos: [makeRepo({ id: 'live-repo', path: livePath })],
      worktreeMeta: {
        [liveKey]: meta(),
        [orphanSamePathKey]: meta(),
        [orphanRemoteHostKey]: meta({ hostId: 'ssh:conn-x' })
      }
    })

    const store = await createStore()
    const kept = Object.keys(store.getAllWorktreeMeta())

    expect(kept).toContain(liveKey)
    expect(kept).not.toContain(orphanSamePathKey)
    expect(kept).not.toContain(orphanRemoteHostKey)
  })

  it('sweeps workspace-session owner keys for a repo id absent from repos, across the legacy blob and host partitions', async () => {
    const liveKey = `live-repo::${testState.dir}`
    const orphanKey = 'orphan-repo::/home/tiger/workspace/libtorch'
    const orphanEditorOnlyKey = 'orphan-repo::/home/tiger/workspace/editor-only'
    const liveTab = makeTerminalTab({ id: 'live-tab', worktreeId: liveKey })
    const orphanTab = makeTerminalTab({ id: 'orphan-tab', worktreeId: orphanKey })
    const orphanFile = {
      filePath: '/home/tiger/workspace/editor-only/README.md',
      relativePath: 'README.md',
      worktreeId: orphanEditorOnlyKey,
      language: 'markdown'
    }
    const sshHost = toSshExecutionHostId('conn-1')
    writeDataFile({
      repos: [makeRepo({ id: 'live-repo', path: testState.dir })],
      worktreeMeta: { [liveKey]: { displayName: '', comment: '', lastActivityAt: 1 } },
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'orphan-repo',
        activeWorkspaceKey: worktreeWorkspaceKey(orphanKey),
        activeWorktreeId: orphanKey,
        activeWorktreeIdsOnShutdown: [orphanKey, liveKey],
        tabsByWorktree: { [liveKey]: [liveTab], [orphanKey]: [orphanTab] },
        terminalLayoutsByTabId: {
          'live-tab': { root: null, activeLeafId: null, expandedLeafId: null },
          'orphan-tab': { root: null, activeLeafId: null, expandedLeafId: null }
        },
        remoteSessionIdsByTabId: {
          'live-tab': 'remote-live',
          'orphan-tab': 'remote-orphan'
        },
        openFilesByWorktree: { [orphanEditorOnlyKey]: [orphanFile] },
        lastVisitedAtByWorktreeId: { [liveKey]: 5, [orphanKey]: 9 }
      },
      workspaceSessionsByHostId: {
        [sshHost]: {
          ...getDefaultWorkspaceSession(),
          openFilesByWorktree: { [orphanEditorOnlyKey]: [orphanFile] }
        }
      }
    })

    const store = await createStore()
    const legacy = store.getWorkspaceSession()

    expect(legacy.tabsByWorktree[liveKey]).toBeDefined()
    expect(legacy.tabsByWorktree[orphanKey]).toBeUndefined()
    expect(legacy.lastVisitedAtByWorktreeId?.[liveKey]).toBe(5)
    expect(legacy.lastVisitedAtByWorktreeId?.[orphanKey]).toBeUndefined()
    expect(legacy.terminalLayoutsByTabId['live-tab']).toBeDefined()
    expect(legacy.terminalLayoutsByTabId['orphan-tab']).toBeUndefined()
    expect(legacy.remoteSessionIdsByTabId?.['live-tab']).toBe('remote-live')
    expect(legacy.remoteSessionIdsByTabId?.['orphan-tab']).toBeUndefined()
    expect(legacy.openFilesByWorktree?.[orphanEditorOnlyKey]).toBeUndefined()
    expect(legacy.activeRepoId).toBeNull()
    expect(legacy.activeWorkspaceKey).toBeNull()
    expect(legacy.activeWorktreeId).toBeNull()
    expect(legacy.activeWorktreeIdsOnShutdown).toEqual([liveKey])

    const hostSession = store.getWorkspaceSession(sshHost)
    expect(hostSession.openFilesByWorktree?.[orphanEditorOnlyKey]).toBeUndefined()
  })

  it('keeps a live local repo id when the same id was removed on an SSH host (host-scoped orphan detection)', async () => {
    const sshHost = toSshExecutionHostId('conn-1')
    const localKey = `dup::${testState.dir}`
    const sshKey = 'dup::/home/tiger/gone'
    writeDataFile({
      repos: [makeRepo({ id: 'dup', path: testState.dir })],
      worktreeMeta: {
        [localKey]: { displayName: '', comment: '', lastActivityAt: 1 },
        [sshKey]: { displayName: '', comment: '', lastActivityAt: 1, hostId: sshHost }
      },
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { [localKey]: 5 }
      },
      workspaceSessionsByHostId: {
        [sshHost]: {
          ...getDefaultWorkspaceSession(),
          lastVisitedAtByWorktreeId: { [sshKey]: 9 }
        }
      }
    })

    const store = await createStore()
    const kept = Object.keys(store.getAllWorktreeMeta())
    expect(kept).toContain(localKey)
    expect(kept).not.toContain(sshKey)
    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.[localKey]).toBe(5)
    expect(
      store.getWorkspaceSession(sshHost).lastVisitedAtByWorktreeId?.[sshKey]
    ).toBeUndefined()
  })

  it('sweeps a session owner that survives only as a terminal-surface tombstone', async () => {
    const liveKey = `live-repo::${testState.dir}`
    const orphanKey = 'orphan-repo::/home/tiger/gone'
    writeDataFile({
      repos: [makeRepo({ id: 'live-repo', path: testState.dir })],
      worktreeMeta: { [liveKey]: { displayName: '', comment: '', lastActivityAt: 1 } },
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        terminalSurfaceTombstonesByPaneKey: {
          'orphan-pane': {
            worktreeId: orphanKey,
            parentTabId: 'orphan-tab',
            leafId: 'leaf-1',
            ptyId: 'pty-1',
            incarnationId: 'inc-1',
            retiredAt: 1
          }
        }
      }
    })

    const store = await createStore()
    expect(
      store.getWorkspaceSession().terminalSurfaceTombstonesByPaneKey?.['orphan-pane']
    ).toBeUndefined()
  })

  it('does not wipe worktree state when there are no live repos (guards an anomalous empty-owner load)', async () => {
    const key = 'some-repo::/home/tiger/gone'
    writeDataFile({
      repos: [],
      worktreeMeta: {
        [key]: { displayName: '', comment: '', lastActivityAt: 1, hostId: 'ssh:conn-1' }
      }
    })

    const store = await createStore()
    expect(Object.keys(store.getAllWorktreeMeta())).toContain(key)
  })

  it('sweeps and persists a lineage entry whose parent repo id is gone (no worktreeMeta/session twin)', async () => {
    const liveKey = `live-repo::${testState.dir}`
    writeDataFile({
      repos: [makeRepo({ id: 'live-repo', path: testState.dir })],
      worktreeMeta: { [liveKey]: { displayName: '', comment: '', lastActivityAt: 1 } },
      worktreeLineageById: { [liveKey]: { parentWorktreeId: 'orphan-repo::/home/tiger/gone' } }
    })

    const store = await createStore()
    expect(store.getWorktreeLineage(liveKey)).toBeUndefined()

    store.flush()
    const persisted = readDataFile() as { worktreeLineageById?: Record<string, unknown> }
    expect(persisted.worktreeLineageById?.[liveKey]).toBeUndefined()
  })
})
