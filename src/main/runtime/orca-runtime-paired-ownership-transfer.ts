import type { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import {
  PtyOwnershipTransferCoordinator,
  type PtyOwnershipTransferCoordinatorOptions
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-coordinator'
import type { PtyOwnershipTransferExecuteResult } from '../../shared/pty-ownership-transfer-orchestration'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../shared/pty-ownership-transfer-surface-binding'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import type { RuntimePtyOwnershipTransferSourceAdapter } from '../providers/runtime-pty-ownership-transfer-source-adapter'
import type { RuntimePtyOwnershipTransferAttachmentBinding } from '../providers/runtime-pty-ownership-transfer-source-adapter'
import {
  parsePtyOwnershipTransferSourceGrant,
  PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
  samePtyOwnershipTransferSourceGrant,
  type PtyOwnershipTransferSourceGrant,
  type PtyOwnershipTransferSourceGrantRequest
} from '../../shared/pty-ownership-transfer-source-grant'
import { PairedRuntimePtyOwnershipTransferClient } from './paired-runtime-pty-ownership-transfer-client'
import { makePaneKey } from '../../shared/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

export class OrcaRuntimeWithPairedOwnershipTransfer extends OrcaRuntimeWithResolveWaiter {
  getPtyOwnershipTransferDestinationRegistry(): PtyOwnershipTransferDestinationRuntimeRegistry | null {
    return this.ptyOwnershipTransferDestinationRegistry
  }

  getLocalPtyOwnershipTransferSource(): RuntimePtyOwnershipTransferSourceAdapter | null {
    return this.getLocalPtyOwnershipTransferSourceFn?.() ?? null
  }

  async issuePairedRuntimePtyOwnershipTransferSourceGrant(
    request: PtyOwnershipTransferSourceGrantRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): Promise<PtyOwnershipTransferSourceGrant> {
    if (!this.ptyOwnershipTransferMutationEnabled()) {
      throw new Error('pty_ownership_transfer_production_transfer_disabled')
    }
    const source = this.getLocalPtyOwnershipTransferReadOnlySourceFn?.()
    const provider = this.getLocalProvider()
    if (!source?.issueOwnershipTransferSourceGrant || !provider) {
      throw new Error('pty_ownership_transfer_runtime_source_unavailable')
    }
    const remote = parseRemoteRuntimePtyId(request.surfaceBinding.ptyId)
    const workspace = parseWorkspaceKey(request.surfaceBinding.workspaceKey)
    const tracked = this.ptysById.get(request.terminalId)
    const expectedWorktreeId =
      workspace?.type === 'folder'
        ? folderWorkspaceKey(workspace.folderWorkspaceId)
        : workspace?.worktreeId
    if (
      !remote?.environmentId ||
      remote.handle !== request.terminalId ||
      !expectedWorktreeId ||
      !tracked ||
      !tracked.connected ||
      tracked.connectionId !== null ||
      tracked.worktreeId !== expectedWorktreeId ||
      tracked.tabId !== request.surfaceBinding.tabId ||
      tracked.paneKey !== makePaneKey(request.surfaceBinding.tabId, request.surfaceBinding.leafId)
    ) {
      throw new Error('pty_ownership_transfer_source_surface_mismatch')
    }
    const reconciliation = await source.reconcileProvider(provider)
    const current = this.ptysById.get(request.terminalId)
    if (
      !reconciliation ||
      typeof reconciliation !== 'object' ||
      !('state' in reconciliation) ||
      reconciliation.state !== 'current' ||
      this.getLocalProvider() !== provider ||
      current !== tracked ||
      !current.incarnationId
    ) {
      throw new Error('pty_ownership_transfer_source_authority_unavailable')
    }
    const grant = source.issueOwnershipTransferSourceGrant(request, binding)
    if (
      grant.identity.terminalId !== request.terminalId ||
      grant.identity.incarnationId !== current.incarnationId ||
      grant.identity.destinationRuntimeId !== request.destinationRuntimeId ||
      !samePtyOwnershipTransferSurfaceBinding(grant.surfaceBinding, request.surfaceBinding)
    ) {
      throw new Error('pty_ownership_transfer_source_authority_unavailable')
    }
    return grant
  }

  createPairedRuntimePtyOwnershipTransferSource(
    environmentId: string
  ): PairedRuntimePtyOwnershipTransferClient | null {
    if (
      !environmentId ||
      !this.callPairedRuntimePtyOwnershipTransferRpcFn ||
      !this.subscribePairedRuntimePtyOwnershipTransferFn
    ) {
      return null
    }
    return new PairedRuntimePtyOwnershipTransferClient(
      environmentId,
      this.callPairedRuntimePtyOwnershipTransferRpcFn,
      this.subscribePairedRuntimePtyOwnershipTransferFn
    )
  }

  createPairedRuntimePtyOwnershipTransferCoordinator(
    options: Omit<
      PtyOwnershipTransferCoordinatorOptions,
      'source' | 'destination' | 'destinationCapabilities' | 'getDestinationCapabilities'
    > & { environmentId: string }
  ): PtyOwnershipTransferCoordinator | null {
    if (!this.ptyOwnershipTransferMutationEnabled()) {
      return null
    }
    const destination = this.ptyOwnershipTransferDestinationRegistry
    const { environmentId, ...coordinatorOptions } = options
    const source = this.createPairedRuntimePtyOwnershipTransferSource(environmentId)
    if (!destination || !source || options.identity.destinationRuntimeId !== this.runtimeId) {
      return null
    }
    let surfaceBinding: PtyOwnershipTransferSurfaceBinding
    try {
      surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(options.surfaceBinding)
      const remote = parseRemoteRuntimePtyId(surfaceBinding.ptyId)
      if (
        !remote?.environmentId ||
        remote.environmentId !== environmentId ||
        remote.handle !== options.identity.terminalId
      ) {
        return null
      }
      validatePtyOwnershipTransferDestinationOutputRoute(
        {
          runtimeId: this.runtimeId,
          inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
        },
        options.identity,
        surfaceBinding
      )
    } catch {
      return null
    }
    return new PtyOwnershipTransferCoordinator({
      ...coordinatorOptions,
      surfaceBinding,
      source,
      destination,
      getDestinationCapabilities: async () => {
        if (!this.ptyOwnershipTransferMutationEnabled()) {
          throw new Error('pty_ownership_transfer_production_transfer_disabled')
        }
        const preflight = await this.ptyOwnershipTransferOrchestrator.preflight({
          connectionId: null,
          ptyId: surfaceBinding.ptyId,
          destinationRuntimeId: this.runtimeId
        })
        if (preflight.topology !== 'paired-runtime-reference' || !preflight.transferSupported) {
          throw new Error(
            `pty_ownership_transfer_preflight_blocked:${preflight.blocker ?? 'unknown'}`
          )
        }
        return preflight.capabilities
      }
    })
  }

  async transferPairedRuntimePtyOwnership(
    request: Readonly<{
      ptyId: string
      surfaceBinding: PtyOwnershipTransferSurfaceBinding
      timeoutMs?: number
    }>,
    options: { signal?: AbortSignal } = {}
  ): Promise<PtyOwnershipTransferExecuteResult> {
    if (!this.ptyOwnershipTransferMutationEnabled()) {
      throw new Error('pty_ownership_transfer_production_transfer_disabled')
    }
    const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(request.surfaceBinding)
    const remote = parseRemoteRuntimePtyId(request.ptyId)
    const tracked = this.ptysById.get(request.ptyId)
    if (
      !remote?.environmentId ||
      !remote.handle ||
      surfaceBinding.ptyId !== request.ptyId ||
      !tracked ||
      !tracked.connected ||
      tracked.connectionId !== null ||
      tracked.tabId !== surfaceBinding.tabId ||
      tracked.paneKey !== makePaneKey(surfaceBinding.tabId, surfaceBinding.leafId)
    ) {
      throw new Error('pty_ownership_transfer_paired_surface_mismatch')
    }
    const call = this.callPairedRuntimePtyOwnershipTransferRpcFn
    if (!call) {
      throw new Error('pty_ownership_transfer_paired_transport_unavailable')
    }
    const grantRequest: PtyOwnershipTransferSourceGrantRequest = Object.freeze({
      version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
      terminalId: remote.handle,
      destinationRuntimeId: this.runtimeId,
      surfaceBinding
    })
    const callGrant = async (): Promise<PtyOwnershipTransferSourceGrant> =>
      parsePtyOwnershipTransferSourceGrant(
        await call(remote.environmentId!, 'pty.ownershipTransfer.grantSource', grantRequest, {
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal })
        })
      )
    const grant = await callGrant()
    if (
      grant.identity.terminalId !== remote.handle ||
      grant.identity.destinationRuntimeId !== this.runtimeId ||
      !samePtyOwnershipTransferSurfaceBinding(grant.surfaceBinding, surfaceBinding) ||
      this.ptysById.get(request.ptyId) !== tracked ||
      (tracked.incarnationId !== null && tracked.incarnationId !== grant.identity.incarnationId)
    ) {
      throw new Error('pty_ownership_transfer_source_authority_unavailable')
    }
    tracked.incarnationId = grant.identity.incarnationId
    const preflight = await this.ptyOwnershipTransferOrchestrator.preflight({
      connectionId: null,
      ptyId: request.ptyId,
      destinationRuntimeId: this.runtimeId
    })
    if (!preflight.transferSupported) {
      throw new Error(`pty_ownership_transfer_preflight_blocked:${preflight.blocker ?? 'unknown'}`)
    }
    const coordinator = this.createPairedRuntimePtyOwnershipTransferCoordinator({
      environmentId: remote.environmentId,
      identity: grant.identity,
      surfaceBinding,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
    if (!coordinator) {
      throw new Error('pty_ownership_transfer_coordinator_unavailable')
    }
    const result = await coordinator.transfer()
    const currentGrant = await callGrant()
    const destination = result.destination.snapshot()
    if (
      this.ptysById.get(request.ptyId) !== tracked ||
      tracked.incarnationId !== grant.identity.incarnationId ||
      !samePtyOwnershipTransferSourceGrant(currentGrant, grant) ||
      destination.phase !== 'published' ||
      destination.executionVerdict !== 'live'
    ) {
      throw new Error('pty_ownership_transfer_published_route_unavailable')
    }
    return Object.freeze({
      identity: result.identity,
      commitReceipt: result.commitReceipt,
      publicationReceipt: result.publicationReceipt
    })
  }
}
