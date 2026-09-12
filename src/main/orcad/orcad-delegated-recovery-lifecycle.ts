import type { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import type { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { readCapturedPtyPublicationRetry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-captured-publication-retry'
import { OrcadDelegatedConnectionSupervisor } from './orcad-delegated-connection-supervisor'
import { OrcadLocalRelayUnavailableError } from './orcad-local-relay-unavailable'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { createOrcadDelegatedPublicationInspectors } from './orcad-delegated-publication-inspectors'
import { retireOrcadPublishedSourceDelivery } from './orcad-delegated-source-retirement'
import type { RuntimeCapturedSourceRetirementRequest } from '../runtime/runtime-ownership-transfer-contracts'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import type { OrcadDelegatedConnectionOptions } from './orcad-delegated-connection-contract'
import type { OrcadDelegatedExitEvent } from './orcad-delegated-exit-delivery'
import type { RecoverPtyOwnershipRetirement } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-runtime-recovery'
import type {
  PtyOwnershipTransferWireIdentity,
  PtyOwnershipTransferOutputFrame
} from '../../shared/pty-ownership-transfer-wire'

export function installOrcadDelegatedRecovery(options: {
  enabled: boolean
  registry: PtyOwnershipTransferDestinationRuntimeRegistry | null
  lifetime: OrcadRuntimeLifetime
  onError: ConstructorParameters<typeof OrcadDelegatedConnectionSupervisor>[0]['onError']
  bindConnection?: ConstructorParameters<
    typeof OrcadDelegatedConnectionSupervisor
  >[0]['bindConnection']
  onExit?: (event: OrcadDelegatedExitEvent) => void
  recoverRetirement?: RecoverPtyOwnershipRetirement
  onExecutionState?: OrcadDelegatedConnectionOptions['onExecutionState']
  providerModel?: {
    snapshot: (
      identity: PtyOwnershipTransferWireIdentity,
      options?: { scrollbackRows?: number }
    ) => Promise<PtyProviderBufferSnapshot | null>
    sequence: (identity: PtyOwnershipTransferWireIdentity) => number
  }
  initializeModel: (
    identity: PtyOwnershipTransferWireIdentity,
    signal: AbortSignal
  ) => Promise<void>
  prepareModelFrame: (
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame,
    signal: AbortSignal
  ) => Promise<void>
}) {
  if (!options.enabled || !options.registry) {
    return null
  }
  const controller = new AbortController()
  const preparations = new Map<string, Promise<unknown>>()
  const supervisor = new OrcadDelegatedConnectionSupervisor({
    signal: controller.signal,
    retryAfterBudget: (error) => error instanceof OrcadLocalRelayUnavailableError,
    bindConnection: options.bindConnection,
    recoverRetirement: options.recoverRetirement
      ? (destination) => {
          const retirement = destination.outbox.loadRetirement(destination.identity)
          if (!retirement) {
            return false
          }
          options.recoverRetirement!({ retirement, outbox: destination.outbox })
          if (destination.outbox.loadRetirement(destination.identity)?.phase !== 'applied') {
            throw new Error('orcad_delegated_retirement_incomplete')
          }
          return true
        }
      : undefined,
    onError: options.onError
  })
  options.lifetime.add(async () => {
    controller.abort()
    await Promise.all([supervisor.stop(), Promise.allSettled(preparations.values())])
  })
  type Destination = ReturnType<
    PtyOwnershipTransferDestinationRuntimeRegistry['recoverPersistedDelegatedDestinations']
  >[number]
  type TrackedDestination = Parameters<OrcadDelegatedConnectionSupervisor['track']>[0]
  const tracked = new Map<string, TrackedDestination>()
  const initializationErrors = new Map<string, unknown>()
  const initializedModels = new Set<string>()
  const track = (destination: Destination) => {
    controller.signal.throwIfAborted()
    const existing = tracked.get(destination.identity.bridgeId)
    if (existing) {
      if (
        !samePtyOwnershipTransferIdentity(existing.identity, destination.identity) ||
        existing.adapter !== destination.adapter ||
        existing.store !== destination.store ||
        existing.outbox !== destination.outbox
      ) {
        throw new Error('orcad_delegated_lifecycle_destination_conflict')
      }
      supervisor.track(existing)
      return
    }
    const identity = Object.freeze({ ...destination.identity })
    let initialized = false
    let initializing: Promise<void> | undefined
    const trackedDestination: TrackedDestination = {
      ...destination,
      identity,
      onExit:
        options.onExit && options.recoverRetirement
          ? (event) => {
              options.onExit!(event)
              if (destination.outbox.loadRetirement(identity)?.phase !== 'applied') {
                throw new Error('orcad_delegated_retirement_incomplete')
              }
              void supervisor.retire(identity).catch((error) => options.onError(identity, error))
            }
          : options.onExit,
      onExecutionState: options.onExecutionState,
      providerModel: options.providerModel
        ? {
            snapshot: (request) => {
              controller.signal.throwIfAborted()
              return options.providerModel!.snapshot(identity, request)
            },
            sequence: () => options.providerModel!.sequence(identity)
          }
        : undefined,
      initializeModel: async (signal) => {
        controller.signal.throwIfAborted()
        signal.throwIfAborted()
        if (initialized) {
          return
        }
        initializing ??= Promise.resolve()
          .then(async () => {
            controller.signal.throwIfAborted()
            signal.throwIfAborted()
            await options.initializeModel(identity, signal)
            controller.signal.throwIfAborted()
            signal.throwIfAborted()
            initialized = true
            initializedModels.add(identity.bridgeId)
            initializationErrors.delete(identity.bridgeId)
          })
          .catch((error: unknown) => {
            initializationErrors.set(identity.bridgeId, error)
            throw error
          })
          .finally(() => {
            initializing = undefined
          })
        await initializing
        signal.throwIfAborted()
      },
      prepareModelFrame: (frame) => {
        controller.signal.throwIfAborted()
        return options.prepareModelFrame(identity, Object.freeze({ ...frame }), controller.signal)
      }
    }
    supervisor.track(trackedDestination)
    tracked.set(identity.bridgeId, trackedDestination)
  }
  for (const destination of options.registry.recoverPersistedDelegatedDestinations(
    options.recoverRetirement
  )) {
    track(destination)
  }
  const registry = options.registry
  const waitForDestinationCommit = async (
    identity: PtyOwnershipTransferWireIdentity,
    requestSignal: AbortSignal
  ) => {
    const signal = AbortSignal.any([controller.signal, supervisor.signal, requestSignal])
    signal.throwIfAborted()
    await supervisor.settlePendingConnection(identity, signal)
    const connection = supervisor.getConnection(identity)
    if (!connection) {
      throw new Error('orcad_delegated_pty_authority_unverifiable')
    }
    await connection.waitForCommitReconciled(signal)
    signal.throwIfAborted()
    if (supervisor.getConnection(identity) !== connection) {
      throw new Error('orcad_delegated_pty_authority_unverifiable')
    }
    return connection
  }
  const initialDestinations = [...tracked.values()]
  const settleInitialRecovery = async (allowUnavailableSources = false) => {
    await supervisor.settlePendingConnections()
    controller.signal.throwIfAborted()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const unavailableSources: PtyOwnershipTransferWireIdentity[] = []
    await Promise.all(
      initialDestinations.map(async (destination) => {
        if (destination.outbox.loadRetirement(destination.identity)?.phase === 'applied') {
          return
        }
        if (initializationErrors.has(destination.identity.bridgeId)) {
          throw initializationErrors.get(destination.identity.bridgeId)
        }
        const connection = supervisor.getConnection(destination.identity)
        if (!connection) {
          const error = supervisor.getConnectionError(destination.identity)
          if (
            allowUnavailableSources &&
            initializedModels.has(destination.identity.bridgeId) &&
            error instanceof OrcadLocalRelayUnavailableError
          ) {
            unavailableSources.push(destination.identity)
            return
          }
          if (allowUnavailableSources && error) {
            throw error
          }
          throw new Error('orcad_delegated_pty_authority_unverifiable')
        }
        await waitForDestinationCommit(destination.identity, signal)
      })
    )
    return unavailableSources
  }
  return {
    supervisor,
    settleInitialRecovery,
    waitForDestinationCommit,
    supportsCapturedSourceRetirementRecovery: () =>
      !controller.signal.aborted && !supervisor.signal.aborted,
    retirePublishedSourceDelivery: async (request: RuntimeCapturedSourceRetirementRequest) => {
      request.assertAuthority()
      const identity = Object.freeze(parsePtyOwnershipTransferWireIdentity(request.identity))
      const signal = AbortSignal.any([controller.signal, supervisor.signal, request.signal])
      const connection = await waitForDestinationCommit(identity, signal)
      return retireOrcadPublishedSourceDelivery({
        ...request,
        identity,
        signal,
        registry,
        supervisor,
        connection
      })
    },
    ...createOrcadDelegatedPublicationInspectors({
      registry,
      supervisor,
      signal: controller.signal,
      waitForDestinationCommit
    }),
    supportsCapturedCatalogPublication: () =>
      !controller.signal.aborted &&
      !supervisor.signal.aborted &&
      registry.supportsCapturedCatalogPublication(),
    prepareCapturedDestination: (
      request: Parameters<
        PtyOwnershipTransferDestinationRuntimeRegistry['prepareCapturedDelegated']
      >[0]
    ) => {
      const bridgeId = request.identity.bridgeId
      if (preparations.has(bridgeId)) {
        return Promise.reject(new Error('pty_ownership_transfer_captured_preparation_pending'))
      }
      const signal = AbortSignal.any([controller.signal, supervisor.signal, request.signal])
      const captured = { ...request, identity: Object.freeze({ ...request.identity }), signal }
      const operation = Promise.resolve().then(async () => {
        signal.throwIfAborted()
        registry.assertDestinationAdmissionOpen()
        const prepared =
          registry.get(captured.identity.bridgeId)?.snapshot().phase === 'published'
            ? readCapturedPtyPublicationRetry(
                captured,
                registry.getPublishedDelegatedDestination(captured.identity)
              )
            : await registry.prepareCapturedDelegated(captured)
        signal.throwIfAborted()
        track(registry.getPublishedDelegatedDestination(prepared.snapshot.identity))
        if (captured.catalogAdmission !== undefined) {
          await waitForDestinationCommit(
            captured.identity,
            AbortSignal.any([signal, AbortSignal.timeout(captured.timeoutMs ?? 15_000)])
          )
        }
        return prepared
      })
      preparations.set(bridgeId, operation)
      return operation.finally(() => {
        if (preparations.get(bridgeId) === operation) {
          preparations.delete(bridgeId)
        }
      })
    },
    trackPublishedDestination: (identity: PtyOwnershipTransferWireIdentity) => {
      controller.signal.throwIfAborted()
      track(registry.getPublishedDelegatedDestination(identity))
    }
  }
}
