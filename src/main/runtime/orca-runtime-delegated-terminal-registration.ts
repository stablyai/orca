import { OrcaRuntimeWithOwnershipTransferCheckpoints } from './orca-runtime-ownership-transfer-checkpoints'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import { parseWorkspaceKey, folderWorkspaceKey } from '../../shared/workspace-scope'
import { makePaneKey } from '../../shared/stable-pane-id'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import {
  hasDelegatedPtyProviderRoute,
  snapshotDelegatedPtyProviderRoutes,
  reserveDelegatedPtyProviderRoute
} from '../ipc/pty/provider/delegated-provider-routes'

export class OrcaRuntimeWithDelegatedTerminalRegistration extends OrcaRuntimeWithOwnershipTransferCheckpoints {
  assertPublishedDelegatedPtyReserved(identity: PtyOwnershipTransferWireIdentity): void {
    const destination =
      this.ptyOwnershipTransferDestinationRegistry?.getPublishedDelegatedDestination(identity)
    const binding = destination?.adapter.snapshot().surfaceBinding
    const route = snapshotDelegatedPtyProviderRoutes().find(
      (candidate) => candidate.identity.terminalId === identity.terminalId
    )
    if (!binding || !route || !samePtyOwnershipTransferIdentity(route.identity, identity)) {
      throw new Error('pty_ownership_transfer_delegated_reservation_unavailable')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      { runtimeId: this.runtimeId, inspectPty: (id) => this.ptysById.get(id) ?? null },
      identity,
      binding
    )
    if (!route.isCurrent()) {
      throw new Error('pty_ownership_transfer_delegated_reservation_stale')
    }
  }

  acceptDelegatedPtyExecutionState(
    identity: PtyOwnershipTransferWireIdentity,
    claim: PtyOwnershipTransferDestinationClaim
  ): boolean {
    const retirement = this.ptyOwnershipTransferDestinationRegistry
      ?.getDelegatedModelOutbox(identity)
      ?.loadRetirement(identity)
    if (retirement) {
      const retiredClaim = retirement.event.destinationClaim
      if (retiredClaim.generation !== claim.generation || retiredClaim.claimId !== claim.claimId) {
        throw new Error('pty_ownership_transfer_delegated_execution_stale')
      }
      return false
    }
    const destination =
      this.ptyOwnershipTransferDestinationRegistry?.getPublishedDelegatedDestination(identity)
    const snapshot = destination?.adapter.snapshot()
    const binding = snapshot?.surfaceBinding
    if (
      !snapshot ||
      !binding ||
      snapshot.delegatedClaim?.generation !== claim.generation ||
      snapshot.delegatedClaim.claimId !== claim.claimId
    ) {
      throw new Error('pty_ownership_transfer_delegated_execution_stale')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (id) => this.ptysById.get(id) ?? null
      },
      identity,
      binding
    )
    if (snapshot.executionVerdict === 'exited') {
      return false
    }
    const live = snapshot.executionVerdict === 'live' && snapshot.delegatedClaimActive === true
    const pty = this.ptysById.get(binding.ptyId)!
    const changed = pty.connected !== live
    this.recordPtyWorktree(binding.ptyId, pty.worktreeId, { connected: live })
    if (live) {
      this.markPtyLivenessLive(binding.ptyId)
    } else {
      this.markPtyLivenessUnverifiable(binding.ptyId, 'delegated_source_unverifiable')
    }
    return changed
  }

  /** Publication restores identity, not evidence that the incumbent process is reachable. */
  registerPublishedDelegatedPty(identity: PtyOwnershipTransferWireIdentity): void {
    const destination =
      this.ptyOwnershipTransferDestinationRegistry?.getPublishedDelegatedDestination(identity)
    const binding = destination?.adapter.snapshot().surfaceBinding
    const scope = binding && parseWorkspaceKey(binding.workspaceKey)
    if (!binding || !scope || identity.destinationRuntimeId !== this.runtimeId) {
      throw new Error('pty_ownership_transfer_delegated_registration_unavailable')
    }
    const existing = this.ptysById.get(binding.ptyId)
    const projected = {
      incarnationId: identity.incarnationId,
      worktreeId:
        scope.type === 'worktree' ? scope.worktreeId : folderWorkspaceKey(scope.folderWorkspaceId),
      connectionId: null,
      tabId: binding.tabId,
      paneKey: makePaneKey(binding.tabId, binding.leafId)
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: () => existing ?? projected
      },
      identity,
      binding
    )
    if (existing && !hasDelegatedPtyProviderRoute(binding.ptyId)) {
      throw new Error('pty_ownership_transfer_delegated_registration_occupied')
    }
    this.assertPtyRegistrationAllowed(binding.ptyId, identity.incarnationId)
    reserveDelegatedPtyProviderRoute(identity)
    if (existing) {
      return
    }
    this.recordPtyWorktree(binding.ptyId, projected.worktreeId, {
      ...projected,
      connected: false,
      runtimeSessionOwned: true,
      isWsl: false,
      wslDistro: null
    })
    this.markPtyLivenessUnverifiable(binding.ptyId, 'delegated_source_not_connected')
  }
}
