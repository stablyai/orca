import { OrcaRuntimeWithOutgoingSurfaceAbsence } from './orca-runtime-outgoing-surface-absence'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { settleOutgoingSshPtyModels } from './orca-runtime-outgoing-model-settlement'
import { bindOutgoingPtyGraph } from './orca-runtime-outgoing-pty-graph'
import { prepareOutgoingPtyGraphRemoval } from './outgoing-pty-graph-removal'
import { prepareOutgoingPtyModelDisposal } from './outgoing-pty-model-disposal'
import { prepareOutgoingPtyTabRemoval } from './outgoing-pty-tab-removal'
import { prepareOutgoingMobileSnapshotRemoval } from './outgoing-mobile-snapshot-removal'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { bindOutgoingSshPtySurfaceRecord } from './outgoing-ssh-pty-surface-binding'

type RestoredSurface = { ptyId: string; incarnationId: string; surfaceBinding: unknown }

export class OrcaRuntimeWithOutgoingSshCatalog extends OrcaRuntimeWithOutgoingSurfaceAbsence {
  prepareOutgoingSshPtyGraphAndModelCleanup(
    targetId: string,
    restored?: readonly RestoredSurface[]
  ) {
    const inventory = this.bindOutgoingSshPtyCatalogSurfaces(targetId, restored)
    const ids = inventory.surfaces.map(({ ptyId }) => ptyId)
    const expected = new Set(ids)
    const sequences = new Map(ids.map((id) => [id, this.getPtyOutputSequence(id)]))
    const surfaces = new Map(
      inventory.surfaces.map(({ ptyId, surfaceBinding }) => [
        ptyId,
        this.bindOutgoingSshPtySurface(ptyId, surfaceBinding, restored !== undefined)
      ])
    )
    const retiredRecords = new Set<string>()
    const observations = ids.map((id) => ({
      id,
      title: this.ptyTitleTrackersByPtyId.get(id),
      tracker: this.ptyTitleTrackersByPtyId.get(id)?.tracker,
      wait: this.waitBlockedCheckStateByPtyId.get(id),
      titleDisposed: false,
      titleRemoved: false,
      waitRemoved: false
    }))
    const trackerOwners = new Map(
      observations.filter((entry) => entry.tracker).map((entry) => [entry.tracker!, entry.id])
    )
    const assertObservations = () => {
      if (
        trackerOwners.size !== observations.filter((entry) => entry.tracker).length ||
        [...this.ptyTitleTrackersByPtyId].some(
          ([id, entry]) =>
            trackerOwners.has(entry.tracker) && trackerOwners.get(entry.tracker) !== id
        )
      ) {
        throw new Error('orcad_outgoing_source_observation_alias_conflict')
      }
      for (const entry of observations) {
        if (
          entry.title?.tracker !== entry.tracker ||
          this.ptyTitleTrackersByPtyId.get(entry.id) !==
            (entry.titleRemoved ? undefined : entry.title) ||
          this.waitBlockedCheckStateByPtyId.get(entry.id) !==
            (entry.waitRemoved ? undefined : entry.wait)
        ) {
          throw new Error('orcad_outgoing_source_observation_changed')
        }
      }
    }
    const graph = prepareOutgoingPtyGraphRemoval(ids, () => ({
      leaves: this.leaves,
      handles: this.handles,
      byLeaf: this.handleByLeafKey,
      byPty: this.handleByPtyId,
      byIncarnation: this.handleByPtyIncarnation
    }))
    const models = prepareOutgoingPtyModelDisposal(
      this,
      ids,
      this.headlessTerminals,
      restored !== undefined
    )
    const tabs = prepareOutgoingPtyTabRemoval(ids, () => ({ tabs: this.tabs, leaves: this.leaves }))
    const mobile = prepareOutgoingMobileSnapshotRemoval(ids, () => this.mobileSessionTabsByWorktree)
    const notified = new Set<string>()
    const notifiedWorktrees = new Set<string>()
    const assertRecords = () => {
      const current = [...this.ptysById].filter(
        ([id, pty]) =>
          pty.connectionId === targetId || parseAppSshPtyId(id)?.connectionId === targetId
      )
      if (
        current.length !== expected.size - retiredRecords.size ||
        current.some(([id]) => !expected.has(id) || retiredRecords.has(id))
      ) {
        throw new Error('orcad_outgoing_source_catalog_changed')
      }
      for (const [id, sequence] of sequences) {
        if (retiredRecords.has(id)) {
          if (this.ptysById.has(id) || this.ptyOutputSequenceById.has(id)) {
            throw new Error('orcad_outgoing_source_record_reappeared')
          }
          continue
        }
        if (this.getPtyOutputSequence(id) !== sequence) {
          throw new Error('orcad_outgoing_source_output_changed')
        }
        surfaces.get(id)!()
      }
    }
    let running = false
    return {
      remove: async (assertAuthority: () => void, signal: AbortSignal) => {
        if (running) {
          throw new Error('orcad_outgoing_source_cleanup_busy')
        }
        running = true
        const assertCurrent = () => {
          signal.throwIfAborted()
          assertAuthority()
          assertRecords()
          assertObservations()
          graph.assertCurrent()
          models.assertCurrent()
          tabs.assertCurrent()
          mobile.assertCurrent()
        }
        try {
          assertCurrent()
          await models.dispose(assertCurrent, signal)
          assertCurrent()
          for (const entry of observations) {
            assertCurrent()
            if (!entry.titleDisposed) {
              entry.tracker?.dispose()
              entry.titleDisposed = true
            }
            assertCurrent()
            if (!entry.titleRemoved) {
              this.ptyTitleTrackersByPtyId.delete(entry.id)
              entry.titleRemoved = true
            }
            // The tracker is already disposed; reuse the remaining title-state cleanup.
            this.disposePtyTitleTracker(entry.id)
            assertCurrent()
            if (!entry.waitRemoved) {
              this.clearWaitBlockedCheckState(entry.id)
              entry.waitRemoved = true
            }
          }
          assertCurrent()
          const removed = graph.remove()
          tabs.removeEmpty()
          mobile.apply((expected, next) =>
            this.storeMobileSessionSnapshot(expected.worktree, next, {
              expected,
              assertAuthority: assertCurrent
            })
          )
          for (const id of ids) {
            this.headlessHydrationState.delete(id)
            this.detachedPreAllocatedLeaves.delete(id)
            this.mobileSessionTabsAgentStatusHeartbeat.removePty(id)
          }
          for (const handle of removed.handles) {
            this.syntheticTerminalHandles.delete(handle)
          }
          this.rebuildLeafPtyIndex()
          for (const handle of removed.handles) {
            assertCurrent()
            if (!notified.has(handle)) {
              this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
              notified.add(handle)
            }
          }
          for (const worktreeId of mobile.appliedWorktreeIds()) {
            assertCurrent()
            if (!notifiedWorktrees.has(worktreeId)) {
              this.cancelScheduledMobileSessionTabsChanged(worktreeId)
              this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
              this.notifyMobileSessionTabsChangedNow(
                worktreeId,
                ++this.mobileSessionTabsChangeSequence
              )
              notifiedWorktrees.add(worktreeId)
            }
          }
          assertCurrent()
          // Local record retirement is not a host process exit or source-route acknowledgment.
          for (const id of ids) {
            assertCurrent()
            if (!retiredRecords.has(id)) {
              this.ptysById.delete(id)
              this.ptyOutputSequenceById.delete(id)
              retiredRecords.add(id)
            }
          }
          assertCurrent()
          return removed
        } finally {
          running = false
        }
      }
    }
  }

  settleOutgoingSshPtyCatalogModels = (targetId: string, signal: AbortSignal) =>
    settleOutgoingSshPtyModels(this, targetId, signal, (id) => this.headlessTerminals.get(id))

  bindOutgoingSshPtyCatalogSurfaces(targetId: string, restored?: readonly RestoredSurface[]) {
    if (!targetId.trim()) {
      throw new Error('orcad_outgoing_source_target_invalid')
    }
    const tracked = [...this.ptysById.entries()].filter(
      ([id, pty]) =>
        pty.connectionId === targetId || parseAppSshPtyId(id)?.connectionId === targetId
    )
    const originalById = new Map(tracked)
    const assertGraph = bindOutgoingPtyGraph(
      tracked.map(([id]) => id),
      () => ({
        leaves: this.leaves,
        handles: this.handles,
        byLeaf: this.handleByLeafKey,
        byPty: this.handleByPtyId,
        byIncarnation: this.handleByPtyIncarnation
      })
    )
    const panes = new Set<string>()
    const surfaces = tracked.map(([ptyId, pty]) => {
      const route = parseAppSshPtyId(ptyId)
      const pane = pty.paneKey ? parsePaneKey(pty.paneKey) : null
      const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding({
        executionHostId: 'local',
        workspaceKey: pty.worktreeId.startsWith('folder:')
          ? pty.worktreeId
          : worktreeWorkspaceKey(pty.worktreeId),
        tabId: pty.tabId,
        leafId: pane?.leafId,
        ptyId: route?.relayPtyId
      })
      const assertSurface = this.bindOutgoingSshPtySurface(
        ptyId,
        surfaceBinding,
        restored !== undefined
      )
      const paneKey = `${surfaceBinding.tabId}:${surfaceBinding.leafId}`
      if (panes.has(paneKey)) {
        throw new Error('orcad_outgoing_source_catalog_duplicate_pane')
      }
      panes.add(paneKey)
      return { ptyId, incarnationId: pty.incarnationId!, surfaceBinding, assertSurface }
    })
    if (restored) {
      const expected = new Map(restored.map((surface) => [surface.ptyId, surface]))
      if (
        !expected.size ||
        expected.size !== restored.length ||
        expected.size !== surfaces.length ||
        surfaces.some(({ ptyId, incarnationId, surfaceBinding }) => {
          const saved = expected.get(ptyId)
          return (
            !saved ||
            saved.incarnationId !== incarnationId ||
            serializeOrcadMigrationValue(
              parsePtyOwnershipTransferSurfaceBinding(saved.surfaceBinding)
            ) !== serializeOrcadMigrationValue(surfaceBinding)
          )
        })
      ) {
        throw new Error('orcad_outgoing_restored_catalog_mismatch')
      }
    }
    const assertCurrent = () => {
      assertGraph()
      const current = [...this.ptysById.entries()].filter(
        ([id, pty]) =>
          pty.connectionId === targetId || parseAppSshPtyId(id)?.connectionId === targetId
      )
      if (
        current.length !== tracked.length ||
        current.some(([id, pty]) => originalById.get(id) !== pty)
      ) {
        throw new Error('orcad_outgoing_source_catalog_changed')
      }
      for (const surface of surfaces) {
        surface.assertSurface()
      }
    }
    assertCurrent()
    return {
      surfaces: surfaces.map(({ assertSurface: _assert, ...surface }) => structuredClone(surface)),
      assertCurrent
    }
  }

  bindOutgoingSshPtySurface(ptyId: string, value: unknown, allowDisconnected = false): () => void {
    return bindOutgoingSshPtySurfaceRecord(this.ptysById, ptyId, value, allowDisconnected)
  }
}
