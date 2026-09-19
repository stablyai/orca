import type { PtyOwnershipTransferDestinationRecoveryCandidate } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-recovery-candidates'
import {
  PtyOwnershipTransferCoordinator,
  type PtyOwnershipTransferSource
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-coordinator'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferDestinationSnapshot } from '../../shared/pty-ownership-transfer-destination-adapter'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { IPtyProvider } from '../providers/types'
import { OrcaRuntimeWithOwnershipTransferOutput } from './orca-runtime-ownership-transfer-output'

export class OrcaRuntimeWithOwnershipTransferRecovery extends OrcaRuntimeWithOwnershipTransferOutput {
  recoverPtyOwnershipTransferDestinations(): readonly {
    bridgeId: string
    destinationRuntimeId: string
    phase: PtyOwnershipTransferDestinationSnapshot['phase']
  }[] {
    const registry = this.ptyOwnershipTransferDestinationRegistry
    if (!registry) {
      return Object.freeze([])
    }
    try {
      return Object.freeze(
        registry
          .recoverPersistedAdapters()
          .map(({ bridgeId, destinationRuntimeId, phase }) =>
            Object.freeze({ bridgeId, destinationRuntimeId, phase })
          )
      )
    } catch (error) {
      console.warn('[pty-ownership-transfer] destination recovery failed', error)
      return Object.freeze([])
    }
  }

  recoverPtyOwnershipTransferDestinationsForConnection(
    connectionId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<readonly PtyOwnershipTransferDestinationSnapshot[]> {
    if (!connectionId) {
      return Promise.resolve(Object.freeze([]))
    }
    const inFlight = this.ptyOwnershipTransferRecoveryByConnection.get(connectionId)
    if (inFlight) {
      return inFlight
    }
    const pending = this.recoverPtyOwnershipTransferDestinationsForConnectionInternal(
      connectionId,
      options
    )
    this.ptyOwnershipTransferRecoveryByConnection.set(connectionId, pending)
    void pending
      .finally(() => {
        if (this.ptyOwnershipTransferRecoveryByConnection.get(connectionId) === pending) {
          this.ptyOwnershipTransferRecoveryByConnection.delete(connectionId)
        }
      })
      .catch(() => undefined)
    return pending
  }

  protected async recoverPtyOwnershipTransferDestinationsForConnectionInternal(
    connectionId: string,
    options: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<readonly PtyOwnershipTransferDestinationSnapshot[]> {
    // A startup provider callback must never turn construction into an implicit ownership move.
    if (!this.ptyOwnershipTransferMutationEnabled()) {
      return Object.freeze([])
    }
    const destination = this.ptyOwnershipTransferDestinationRegistry
    const provider = this.getSshProviderFn?.(connectionId) as
      | (IPtyProvider & {
          ownershipTransfer?: PtyOwnershipTransferSource
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
    const source = provider?.ownershipTransfer
    const getSourceIdentity = provider?.getOwnershipTransferSourceIdentity
    const getCapabilities = provider?.getOwnershipBridgeCapabilities
    const installRoute = provider?.installPublishedOwnershipTransferRoute
    if (
      !destination ||
      !provider ||
      !source ||
      !getSourceIdentity ||
      !getCapabilities ||
      !installRoute
    ) {
      return Object.freeze([])
    }

    let candidates: readonly PtyOwnershipTransferDestinationRecoveryCandidate[]
    try {
      // This is read-only discovery; malformed records remain durable and block this pass.
      candidates = destination.listRecoveryCandidates()
      destination.recoverPersistedAdapters()
    } catch (error) {
      console.warn('[pty-ownership-transfer] direct-SSH recovery discovery failed', error)
      return Object.freeze([])
    }

    const recovered: PtyOwnershipTransferDestinationSnapshot[] = []
    for (const candidate of candidates) {
      const journal = candidate.journal
      if (
        candidate.requiresDelegatedSource ||
        journal.destinationRuntimeId !== this.runtimeId ||
        (journal.phase !== 'committed' && journal.phase !== 'published') ||
        !candidate.surfaceBinding
      ) {
        continue
      }
      const ptyId = toAppSshPtyId(connectionId, journal.terminalId)
      if (
        candidate.surfaceBinding.ptyId !== ptyId ||
        candidate.surfaceBinding.executionHostId !== toSshExecutionHostId(connectionId)
      ) {
        continue
      }
      let sourceIdentity: ReturnType<NonNullable<typeof getSourceIdentity>>
      try {
        sourceIdentity = getSourceIdentity(ptyId)
      } catch {
        continue
      }
      if (
        !sourceIdentity ||
        sourceIdentity.terminalId !== journal.terminalId ||
        sourceIdentity.incarnationId !== journal.incarnationId ||
        sourceIdentity.ownerLease !== journal.ownerLease ||
        !Number.isSafeInteger(sourceIdentity.sourceOwnerGeneration) ||
        sourceIdentity.sourceOwnerGeneration <= 0 ||
        sourceIdentity.sourceOwnerGeneration < journal.sourceOwnerGeneration
      ) {
        continue
      }
      // A newer authenticated owner generation requires atomic reconnect rekey. An older
      // capability set cannot safely attach the journal's stale route, so leave it fenced.
      if (sourceIdentity.sourceOwnerGeneration > journal.sourceOwnerGeneration) {
        let capabilities: PtyOwnershipBridgeCapabilities | null
        try {
          capabilities = await getCapabilities({ signal: options.signal })
        } catch {
          continue
        }
        if (!capabilities?.reconnectRekey) {
          continue
        }
      }
      const adapter = destination.get(journal.bridgeId)
      if (!adapter) {
        continue
      }
      const identity: PtyOwnershipTransferWireIdentity = Object.freeze({
        bridgeId: journal.bridgeId,
        terminalId: journal.terminalId,
        incarnationId: journal.incarnationId,
        ownerLease: journal.ownerLease,
        sourceOwnerGeneration: journal.sourceOwnerGeneration,
        destinationRuntimeId: journal.destinationRuntimeId
      })
      try {
        const coordinator = new PtyOwnershipTransferCoordinator({
          source,
          destination,
          identity,
          surfaceBinding: candidate.surfaceBinding,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          getDestinationCapabilities: (requestOptions) =>
            getCapabilities({ signal: requestOptions?.signal }),
          getReconnectGeneration: () => {
            const current = getSourceIdentity(ptyId)
            if (
              !current ||
              current.terminalId !== journal.terminalId ||
              current.incarnationId !== journal.incarnationId ||
              current.ownerLease !== journal.ownerLease
            ) {
              throw new Error('pty_ownership_transfer_source_authority_unavailable')
            }
            return current.sourceOwnerGeneration
          }
        })
        const result = await coordinator.recover()
        const snapshot = result.destination?.snapshot()
        const capabilities = await getCapabilities({ signal: options.signal })
        const providerGeneration = provider.providerGeneration
        if (
          typeof providerGeneration !== 'number' ||
          !Number.isSafeInteger(providerGeneration) ||
          providerGeneration <= 0
        ) {
          throw new Error('pty_ownership_transfer_recovery_route_unavailable')
        }
        if (
          !snapshot ||
          snapshot.phase !== 'published' ||
          snapshot.executionVerdict !== 'live' ||
          !snapshot.attachmentId ||
          !capabilities ||
          this.getSshProviderFn?.(connectionId) !== provider
        ) {
          throw new Error('pty_ownership_transfer_recovery_route_unavailable')
        }
        installRoute.call(provider, {
          ptyId,
          identity,
          attachmentId: snapshot.attachmentId,
          capabilities,
          providerGeneration
        })
        recovered.push(snapshot)
      } catch (error) {
        // Keep the exact source fence and durable destination for explicit retry/review.
        console.warn('[pty-ownership-transfer] direct-SSH recovery candidate skipped', {
          bridgeId: journal.bridgeId,
          error
        })
      }
    }
    return Object.freeze(recovered)
  }
}
