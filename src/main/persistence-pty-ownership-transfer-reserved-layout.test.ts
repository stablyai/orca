import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PtyOwnershipTransferDestinationFileStore,
  ptyOwnershipTransferDestinationDirectory
} from './persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { ownershipTransferSurfaceSnapshotRef } from './persistence/pty-ownership-transfer/pty-ownership-transfer-snapshot-reference'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, readDataFile, testState, dataFile } from './persistence-test-harness'
import { writeTerminalScrollbackStoredBytesDurableSync } from './terminal-scrollback-durable-artifact'
import { getProfileTerminalScrollbackSnapshotRoot } from './terminal-scrollback-snapshots'
import { terminalLayoutAdmissionFixture } from './persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import type { ReservedPtyOwnershipTransferLayout } from './persistence/loading-store/pty-ownership-transfer-reserved-layout-admission'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { PtyOwnershipTransferSnapshotHistory } from './persistence/loading-store/pty-ownership-transfer-snapshot-history'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-reserved-layout-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function setup(kind: 'folder' | 'worktree' = 'worktree') {
  const fixture = terminalLayoutAdmissionFixture(kind)
  const transfers = new PtyOwnershipTransferDestinationFileStore({
    directory: ptyOwnershipTransferDestinationDirectory(dirname(dataFile()))
  })
  const refsByLeafId = new Map<string, string>()
  for (const { identity, surfaceBinding } of fixture.bindings) {
    transfers.prepare(identity, 0)
    transfers.bindSurface(identity, surfaceBinding)
    const receipt = {
      bridgeId: identity.bridgeId,
      receiptId: `receipt-${identity.bridgeId}`,
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
    transfers.commit(identity, receipt)
    const publicationReceipt = transfers.reservePublication(identity, receipt)
    refsByLeafId.set(
      surfaceBinding.leafId,
      ownershipTransferSurfaceSnapshotRef({ surfaceBinding, publicationReceipt })
    )
  }
  const store = createStore()
  store.importOrcadMigrationCatalog(fixture.manifest)
  store.flushOrThrow()
  const session = fixture.manifest.payload.dormantState!.workspaceSession!
  const reservation: ReservedPtyOwnershipTransferLayout = {
    worktreeId: fixture.owner,
    tab: session.tabsByWorktree[fixture.owner][0],
    layout: session.terminalLayoutsByTabId['tab-1'],
    bindings: fixture.bindings.map(({ identity, surfaceBinding }) => ({
      worktreeId: fixture.owner,
      tabId: surfaceBinding.tabId,
      leafId: surfaceBinding.leafId,
      ptyId: surfaceBinding.ptyId,
      incarnationId: identity.incarnationId
    }))
  }
  const request = (index: number) => ({
    ...reservation.bindings[index],
    bindingMode: 'strict-transfer-publication' as const,
    reservedTransferLayout: reservation,
    scrollbackSnapshotRef: refsByLeafId.get(reservation.bindings[index].leafId)!
  })
  for (const index of [0, 1]) {
    writeTerminalScrollbackStoredBytesDurableSync({
      ref: request(index).scrollbackSnapshotRef,
      data: `preserved output ${index}`,
      storage: { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFile()) }
    })
  }
  return { store, reservation, request }
}

describe('reserved transfer layout persistence', () => {
  it.each([
    ['worktree', 0, 1],
    ['worktree', 1, 0],
    ['folder', 0, 1],
    ['folder', 1, 0]
  ] as const)(
    'preserves %s layout through publication order %i/%i and reload',
    (kind, first, second) => {
      const { store, reservation, request } = setup(kind)
      const initial = structuredClone(store.getWorkspaceSession())
      expect(store.persistPtyBinding(request(first))).toBe(true)
      let restored = createStore()
      expect(restored.getWorkspaceSession().terminalLayoutsByTabId).toEqual(
        store.getWorkspaceSession().terminalLayoutsByTabId
      )
      expect(restored.getWorkspaceSession().tabsByWorktree[reservation.worktreeId][0].ptyId).toBe(
        first === 0 ? reservation.bindings[0].ptyId : null
      )
      expect(restored.persistPtyBinding(request(first))).toBe(true)
      expect(restored.persistPtyBinding(request(second))).toBe(true)
      restored = createStore()
      const published = structuredClone(restored.getWorkspaceSession())
      const layout = published.terminalLayoutsByTabId[reservation.tab.id]
      expect(layout.root).toEqual(reservation.layout.root)
      expect(layout.titlesByLeafId).toEqual(reservation.layout.titlesByLeafId)
      expect(layout.activeLeafId).toBe(reservation.layout.activeLeafId)
      expect(published.activeWorktreeId).toBe(initial.activeWorktreeId)
      expect(published.tabsByWorktree[reservation.worktreeId][0]).toEqual({
        ...reservation.tab,
        ptyId: reservation.bindings[0].ptyId
      })
      for (const index of [0, 1]) {
        expect(restored.persistPtyBinding(request(index))).toBe(true)
        expect(layout.ptyIdsByLeafId?.[reservation.bindings[index].leafId]).toBe(
          reservation.bindings[index].ptyId
        )
      }
      expect(restored.getWorkspaceSession()).toEqual(published)
      expect(Object.values(published.terminalTopologyRevisionByRepoId ?? {})).toEqual([2])
    }
  )

  it('installs the complete reserved layout when absent, without stealing focus', () => {
    const { store, reservation, request } = setup()
    store.setWorkspaceSession(getDefaultWorkspaceSession())
    expect(store.persistPtyBinding({ ...request(1), mayCreate: false })).toBe(false)
    expect(store.persistPtyBinding(request(1))).toBe(true)
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[reservation.tab.id].root).toEqual(
      reservation.layout.root
    )
    expect(store.getWorkspaceSession().activeTabId).toBeNull()
  })

  it('restores memory and disk after failed publication, then retries exactly', () => {
    const { store, request } = setup()
    const before = structuredClone(store.getWorkspaceSession())
    const disk = readDataFile()
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk failed')
    })
    expect(() => store.persistPtyBinding(request(1))).toThrow('disk failed')
    expect(store.getWorkspaceSession()).toEqual(before)
    expect(readDataFile()).toEqual(disk)
    expect(store.persistPtyBinding(request(1))).toBe(true)
  })

  it('refuses topology drift, changed snapshots, remote partition or ordinary binding mode', () => {
    const { store, request, reservation } = setup()
    const before = structuredClone(store.getWorkspaceSession())
    expect(store.persistPtyBinding(request(0), 'ssh:other')).toBe(false)
    expect(store.persistPtyBinding({ ...request(0), bindingMode: undefined })).toBe(false)
    expect(store.getWorkspaceSession()).toEqual(before)
    expect(store.persistPtyBinding(request(0))).toBe(true)
    expect(
      store.persistPtyBinding({ ...request(0), scrollbackSnapshotRef: `v1-${'9'.repeat(32)}` })
    ).toBe(false)
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId[reservation.tab.id]
    if (layout.root?.type !== 'split') {
      throw new Error('expected split')
    }
    layout.root.ratio = 0.8
    const drifted = structuredClone(store.getWorkspaceSession())
    expect(store.persistPtyBinding(request(1))).toBe(false)
    expect(store.getWorkspaceSession()).toEqual(drifted)
  })

  it('publishes a live second pane while preserving a dormant first pane', () => {
    const { store, request, reservation } = setup()
    reservation.bindings = reservation.bindings.slice(1)
    const live = request(0)
    expect(store.persistPtyBinding(live)).toBe(true)
    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[reservation.worktreeId][0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId[reservation.tab.id].titlesByLeafId).toEqual(
      reservation.layout.titlesByLeafId
    )
    expect(
      Object.keys(session.terminalLayoutsByTabId[reservation.tab.id].ptyIdsByLeafId ?? {})
    ).toEqual([live.leafId])
  })

  it.each(['folder', 'worktree'] as const)(
    'retains %s host-owned refs across an older renderer full save and quit save',
    (kind) => {
      const { store, request, reservation } = setup(kind)
      expect(store.persistPtyBinding(request(0))).toBe(true)
      expect(store.persistPtyBinding(request(1))).toBe(true)
      const published = structuredClone(store.getWorkspaceSession())
      const fromRenderer = structuredClone(published)
      delete fromRenderer.terminalLayoutsByTabId[reservation.tab.id].scrollbackRefsByLeafId
      delete fromRenderer.terminalPtyIncarnationsByPaneKey
      delete fromRenderer.terminalTopologyRevisionByRepoId
      fromRenderer.terminalLayoutsByTabId[reservation.tab.id].buffersByLeafId = {
        [reservation.bindings[0].leafId]: 'stale renderer model'
      }
      store.setWorkspaceSession(fromRenderer)
      expect(
        store.getWorkspaceSession().terminalLayoutsByTabId[reservation.tab.id]
          .scrollbackRefsByLeafId
      ).toEqual(published.terminalLayoutsByTabId[reservation.tab.id].scrollbackRefsByLeafId)
      expect(
        store.getWorkspaceSession().terminalLayoutsByTabId[reservation.tab.id].buffersByLeafId
      ).toBeUndefined()
      store.stageWorkspaceSessionBeforeUnload(fromRenderer)
      store.flushOrThrow()
      expect(
        createStore().getWorkspaceSession().terminalLayoutsByTabId[reservation.tab.id]
          .scrollbackRefsByLeafId
      ).toEqual(published.terminalLayoutsByTabId[reservation.tab.id].scrollbackRefsByLeafId)
    }
  )

  it.each(['pty', 'incarnation', 'owner', 'host'] as const)(
    'does not transfer history to changed %s authority',
    (field) => {
      const { store, request, reservation } = setup()
      expect(store.persistPtyBinding(request(0))).toBe(true)
      const prior = structuredClone(store.getWorkspaceSession())
      const next = structuredClone(prior)
      const binding = reservation.bindings[0]
      delete next.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
      if (field === 'pty') {
        next.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId![binding.leafId] = 'replacement'
      }
      if (field === 'incarnation') {
        next.terminalPtyIncarnationsByPaneKey![`${binding.tabId}:${binding.leafId}`] = 'replacement'
      }
      if (field === 'owner') {
        const tabs = next.tabsByWorktree[reservation.worktreeId]
        delete next.tabsByWorktree[reservation.worktreeId]
        next.tabsByWorktree['repo-1::/other'] = tabs.map((tab) => ({
          ...tab,
          worktreeId: 'repo-1::/other'
        }))
      }
      const history = new PtyOwnershipTransferSnapshotHistory(dirname(dataFile()))
      expect(
        history.prune(next, store.getRepos(), prior, field === 'host' ? 'ssh:other' : 'local')
          .terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
      ).toBeUndefined()
    }
  )
})
