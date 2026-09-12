import { randomUUID } from 'node:crypto'
import {
  PtyOwnershipTransferCoordinator,
  type PtyOwnershipTransferCoordinatorOptions,
  type PtyOwnershipTransferSource
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-coordinator'
import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferStatusResult,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type {
  PtyOwnershipTransferExecuteRequest,
  PtyOwnershipTransferExecuteResult,
  PtyOwnershipTransferPreflightRequest,
  PtyOwnershipTransferPreflightResult,
  PtyOwnershipTransferStatusProbeRequest
} from '../../shared/pty-ownership-transfer-orchestration'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import { parseAppSshPtyId, toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { IPtyProvider } from '../providers/types'
import { OrcaRuntimeWithCapturedDestinationLifecycle } from './orca-runtime-captured-destination-lifecycle'

export class OrcaRuntimeWithOwnershipTransferExecution extends OrcaRuntimeWithCapturedDestinationLifecycle {
  createPtyOwnershipTransferCoordinator(
    options: Omit<PtyOwnershipTransferCoordinatorOptions, 'source' | 'destination'> & {
      connectionId: string
    }
  ): PtyOwnershipTransferCoordinator | null {
    // Coordinator construction is an authority boundary; keep it closed by default.
    if (!this.ptyOwnershipTransferMutationEnabled()) {
      return null
    }
    const destination = this.ptyOwnershipTransferDestinationRegistry
    if (!destination || !options.connectionId) {
      return null
    }
    if (options.identity.destinationRuntimeId !== this.runtimeId) {
      return null
    }
    const appPtyId = toAppSshPtyId(options.connectionId, options.identity.terminalId)
    const tracked = this.ptysById.get(appPtyId)
    if (!tracked) {
      return null
    }
    try {
      validatePtyOwnershipTransferDestinationOutputRoute(
        {
          runtimeId: this.runtimeId,
          inspectPty: () => tracked
        },
        options.identity,
        options.surfaceBinding
      )
    } catch {
      return null
    }
    const provider = this.getSshProviderFn?.(options.connectionId) as
      | {
          ownershipTransfer?: PtyOwnershipTransferSource
          getOwnershipBridgeCapabilities?: (options?: {
            signal?: AbortSignal
          }) => Promise<PtyOwnershipBridgeCapabilities | null>
        }
      | undefined
    const source = provider?.ownershipTransfer
    if (!source) {
      return null
    }
    return new PtyOwnershipTransferCoordinator({
      ...options,
      source,
      destination,
      // Capability negotiation is refreshed when transfer() starts; a stale preflight result
      // must not authorize a destination attachment after a relay reconnect.
      getDestinationCapabilities: (requestOptions) =>
        provider?.getOwnershipBridgeCapabilities?.({ signal: requestOptions?.signal }) ??
        Promise.resolve(null)
    })
  }

  async transferPtyOwnership(
    request: PtyOwnershipTransferExecuteRequest,
    options?: { signal?: AbortSignal }
  ): Promise<PtyOwnershipTransferExecuteResult> {
    if (
      !request ||
      typeof request.connectionId !== 'string' ||
      request.connectionId.length === 0 ||
      typeof request.ptyId !== 'string' ||
      request.ptyId.length === 0
    ) {
      throw new Error('pty_ownership_transfer_execute_request_invalid')
    }
    const parsed = parseAppSshPtyId(request.ptyId)
    if (
      !parsed ||
      parsed.connectionId !== request.connectionId ||
      request.destinationRuntimeId !== this.runtimeId
    ) {
      throw new Error('pty_ownership_transfer_execute_identity_mismatch')
    }
    const tracked = this.ptysById.get(request.ptyId)
    const provider = this.getSshProviderFn?.(request.connectionId) as
      | (IPtyProvider & {
          providerGeneration?: number
          getOwnershipTransferSourceIdentity?: (id: string) => Readonly<{
            terminalId: string
            incarnationId: string
            ownerLease: string
            sourceOwnerGeneration: number
          }> | null
          installPublishedOwnershipTransferRoute?: (route: {
            ptyId: string
            identity: PtyOwnershipTransferWireIdentity
            attachmentId: string
            capabilities: PtyOwnershipBridgeCapabilities
            providerGeneration: number
          }) => void
        })
      | undefined
    const source = provider?.getOwnershipTransferSourceIdentity?.(request.ptyId)
    const installPublishedOwnershipTransferRoute = provider?.installPublishedOwnershipTransferRoute
    const providerGeneration = provider?.providerGeneration
    if (
      !provider ||
      !tracked ||
      !tracked.incarnationId ||
      !source ||
      source.terminalId !== parsed.relayPtyId ||
      source.incarnationId !== tracked.incarnationId
    ) {
      throw new Error('pty_ownership_transfer_source_authority_unavailable')
    }
    if (
      !installPublishedOwnershipTransferRoute ||
      typeof providerGeneration !== 'number' ||
      !Number.isSafeInteger(providerGeneration) ||
      providerGeneration <= 0
    ) {
      throw new Error('pty_ownership_transfer_published_route_unavailable')
    }
    const identity: PtyOwnershipTransferWireIdentity = Object.freeze({
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      bridgeId: randomUUID(),
      terminalId: source.terminalId,
      incarnationId: source.incarnationId,
      ownerLease: source.ownerLease,
      sourceOwnerGeneration: source.sourceOwnerGeneration,
      destinationRuntimeId: this.runtimeId
    })
    if (request.identity) {
      try {
        const hinted = parsePtyOwnershipTransferWireIdentity(request.identity)
        if (
          hinted.terminalId !== identity.terminalId ||
          hinted.incarnationId !== identity.incarnationId ||
          hinted.ownerLease !== identity.ownerLease ||
          hinted.sourceOwnerGeneration !== identity.sourceOwnerGeneration ||
          hinted.destinationRuntimeId !== identity.destinationRuntimeId
        ) {
          throw new Error('pty_ownership_transfer_execute_identity_mismatch')
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'pty_ownership_transfer_execute_identity_mismatch'
        ) {
          throw error
        }
        throw new Error('pty_ownership_transfer_execute_request_invalid')
      }
    }
    const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(request.surfaceBinding)
    if (surfaceBinding.ptyId !== request.ptyId) {
      throw new Error('pty_ownership_transfer_execute_surface_mismatch')
    }
    const preflight = await this.preflightPtyOwnershipTransfer({
      connectionId: request.connectionId,
      ptyId: request.ptyId,
      destinationRuntimeId: request.destinationRuntimeId
    })
    if (!preflight.transferSupported) {
      throw new Error(`pty_ownership_transfer_preflight_blocked:${preflight.blocker ?? 'unknown'}`)
    }
    const coordinator = this.createPtyOwnershipTransferCoordinator({
      connectionId: request.connectionId,
      identity,
      surfaceBinding,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal })
    })
    if (!coordinator) {
      throw new Error('pty_ownership_transfer_coordinator_unavailable')
    }
    const result = await coordinator.transfer()
    const destination = result.destination.snapshot()
    const currentSource = provider.getOwnershipTransferSourceIdentity?.(request.ptyId)
    if (
      this.getSshProviderFn?.(request.connectionId) !== provider ||
      provider.providerGeneration !== providerGeneration ||
      !currentSource ||
      currentSource.terminalId !== source.terminalId ||
      currentSource.incarnationId !== source.incarnationId ||
      currentSource.ownerLease !== source.ownerLease ||
      currentSource.sourceOwnerGeneration !== source.sourceOwnerGeneration ||
      destination.phase !== 'published' ||
      !destination.attachmentId ||
      destination.executionVerdict !== 'live' ||
      !preflight.capabilities
    ) {
      throw new Error('pty_ownership_transfer_published_route_unavailable')
    }
    installPublishedOwnershipTransferRoute.call(provider, {
      ptyId: request.ptyId,
      identity: result.identity,
      attachmentId: destination.attachmentId,
      capabilities: preflight.capabilities,
      providerGeneration
    })
    return Object.freeze({
      identity: result.identity,
      commitReceipt: result.commitReceipt,
      publicationReceipt: result.publicationReceipt
    })
  }

  preflightPtyOwnershipTransfer(
    request: PtyOwnershipTransferPreflightRequest
  ): Promise<PtyOwnershipTransferPreflightResult> {
    return this.ptyOwnershipTransferOrchestrator.preflight(request)
  }

  getPtyOwnershipTransferStatus(
    request: PtyOwnershipTransferStatusProbeRequest
  ): Promise<PtyOwnershipTransferStatusResult> {
    return this.ptyOwnershipTransferOrchestrator.status(request)
  }
}
