import { OrcaRuntimeWithDelegatedModelClear } from './orca-runtime-delegated-model-clear'
import type { RecoverPtyOwnershipRetirement } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-runtime-recovery'
import { persistPtyOwnershipRetirementSurface } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-retirement-surface'
import { ownershipTransferSurfaceOwnerKey } from '../persistence/loading-store/pty-ownership-transfer-surface-persistence'
import { retireDelegatedPtyProviderRoute } from '../ipc/pty/provider/delegated-provider-routes'

export class OrcaRuntimeWithDelegatedRetirementRecovery extends OrcaRuntimeWithDelegatedModelClear {
  private readonly cleanedDelegatedRetirements = new Set<string>()
  recoverDelegatedPtyRetirement: RecoverPtyOwnershipRetirement = ({ retirement, outbox }) => {
    const { identity, surfaceBinding: binding, exit, destinationClaim } = retirement.event
    const durable = outbox.loadRetirement(identity)
    const store = this.store
    if (
      identity.destinationRuntimeId !== this.runtimeId ||
      !durable ||
      JSON.stringify(durable) !== JSON.stringify(retirement) ||
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      !store.flushOrThrow
    ) {
      throw new Error('pty_ownership_transfer_runtime_retirement_unavailable')
    }
    const persistence = {
      getWorkspaceSession: store.getWorkspaceSession.bind(store),
      setWorkspaceSession: store.setWorkspaceSession.bind(store),
      flushOrThrow: store.flushOrThrow.bind(store)
    }
    const pty = this.ptysById.get(binding.ptyId)
    if (pty && !pty.incarnationId) {
      throw new Error('pty_ownership_transfer_runtime_retirement_unverifiable')
    }
    persistPtyOwnershipRetirementSurface(persistence, retirement)
    const cleanupKey = JSON.stringify(retirement.event)
    if (
      !this.cleanedDelegatedRetirements.has(cleanupKey) &&
      pty?.incarnationId === identity.incarnationId
    ) {
      this.onPtyExit(binding.ptyId, exit.code ?? -1, identity.incarnationId, {
        hostExitConfirmed: true,
        providerExitObserved: true
      })
      this.cleanedDelegatedRetirements.add(cleanupKey)
    } else if (
      !pty &&
      [...this.mobileSessionTabsByWorktree.values()].some((snapshot) =>
        snapshot.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            tab.ptyId === binding.ptyId &&
            tab.parentTabId === binding.tabId &&
            tab.leafId === binding.leafId
        )
      )
    ) {
      this.retireMobileSessionSurfacesForPty(binding.ptyId, identity.incarnationId, [
        {
          worktreeId: ownershipTransferSurfaceOwnerKey(binding.workspaceKey),
          parentTabId: binding.tabId,
          leafId: binding.leafId
        }
      ])
    }
    persistPtyOwnershipRetirementSurface(persistence, retirement)
    outbox.recordRetirement(identity, { ...retirement, phase: 'applied' })
    retireDelegatedPtyProviderRoute(identity, destinationClaim)
  }
}
