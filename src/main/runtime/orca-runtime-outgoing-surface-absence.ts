import { OrcaRuntimeWithDelegatedProviderModel } from './orca-runtime-delegated-provider-model'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { isOutgoingPtyRegistrationFenced } from './outgoing-pty-registration-fence'
import { mobileSnapshotPtyIds } from './outgoing-mobile-snapshot-admission'

export class OrcaRuntimeWithOutgoingSurfaceAbsence extends OrcaRuntimeWithDelegatedProviderModel {
  /** Current local surface absence only; no process verdict, cleanup history or route-release authority. */
  bindOutgoingSshPtySurfaceAbsence(
    targetId: string,
    surfaces: readonly { ptyId: string; surfaceBinding: unknown }[]
  ) {
    const ids = new Set(surfaces.map(({ ptyId }) => ptyId))
    if (!targetId.trim() || !ids.size || ids.size !== surfaces.length) {
      throw new Error('orcad_outgoing_absence_cohort_invalid')
    }
    const bindings = surfaces.map(({ ptyId, surfaceBinding }) => {
      const binding = parsePtyOwnershipTransferSurfaceBinding(surfaceBinding)
      const route = parseAppSshPtyId(ptyId)
      if (
        route?.connectionId !== targetId ||
        route.relayPtyId !== binding.ptyId ||
        binding.executionHostId !== 'local'
      ) {
        throw new Error('orcad_outgoing_absence_cohort_invalid')
      }
      return binding
    })
    const tabs = new Set(bindings.map(({ tabId }) => tabId))
    const leaves = new Set(bindings.map(({ tabId, leafId }) => this.getLeafKey(tabId, leafId)))
    const runtimeId = this.getRuntimeId()
    const isSource = (id: string | null | undefined) =>
      !!id && (ids.has(id) || parseAppSshPtyId(id)?.connectionId === targetId)
    const assertAbsent = () => {
      if (
        this.getRuntimeId() !== runtimeId ||
        [...ids].some((id) => !isOutgoingPtyRegistrationFenced(this, id))
      ) {
        throw new Error('orcad_outgoing_absence_admission_unfenced')
      }
      const indexed = [
        this.ptysById,
        this.headlessTerminals,
        this.headlessHydrationState,
        this.ptyOutputSequenceById,
        this.ptyTitleTrackersByPtyId,
        this.waitBlockedCheckStateByPtyId,
        this.handleByPtyId,
        this.handleByPtyIncarnation,
        this.leavesByPtyId,
        this.detachedPreAllocatedLeaves,
        this.pendingPtyRegistrationIncarnations,
        this.pendingPtyHandleReplacementFences,
        this.terminalSendOperationsByPtyId,
        this.terminalSendOperationsInFlightByPtyId
      ]
      if (
        indexed.some((map) => [...map.keys()].some(isSource)) ||
        [...this.ptysById.values()].some(
          (pty) => pty.connectionId === targetId || isSource(pty.ptyId)
        ) ||
        [...this.leaves].some(
          ([key, leaf]) => leaves.has(key) || tabs.has(leaf.tabId) || isSource(leaf.ptyId)
        ) ||
        [...this.leavesByPtyId.values()].some((entries) =>
          entries.some((leaf) => tabs.has(leaf.tabId) || isSource(leaf.ptyId))
        ) ||
        [...this.detachedPreAllocatedLeaves.values()].some(
          (leaf) => tabs.has(leaf.tabId) || isSource(leaf.ptyId)
        ) ||
        [...this.handles.values()].some(
          (handle) => tabs.has(handle.tabId) || isSource(handle.ptyId)
        ) ||
        [...this.handleByPtyIncarnation.values()].some((entry) => leaves.has(entry.leafKey)) ||
        [...this.handleByLeafKey.keys()].some((key) => leaves.has(key)) ||
        [...this.tabs.keys()].some((id) => tabs.has(id)) ||
        [...this.mobileSessionTabsByWorktree.values()].some(
          (snapshot) =>
            [...mobileSnapshotPtyIds(snapshot)].some(isSource) ||
            snapshot.tabs.some(
              (tab) => tab.type === 'terminal' && !!tab.parentTabId && tabs.has(tab.parentTabId)
            )
        )
      ) {
        throw new Error('orcad_outgoing_source_runtime_surfaces_present')
      }
    }
    assertAbsent()
    return { assertAbsent }
  }
}
