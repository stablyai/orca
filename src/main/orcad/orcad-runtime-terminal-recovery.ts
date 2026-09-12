import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { installOrcadOrchestrationRecovery } from './orcad-orchestration-recovery'
import { createOrcadDelegatedProviderBinding } from './orcad-delegated-pty-provider'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'

export async function recoverOrcadRuntimeTerminals(
  runtime: OrcaRuntimeService,
  lifetime: OrcadRuntimeLifetime,
  getLocalPtyProvider: () => IPtyProvider
): Promise<void> {
  lifetime.add(() => runtime.stopLegacyWorkerTerminalRecovery())
  runtime.recoverPtyOwnershipTransferDestinations()
  let unavailableSources: readonly PtyOwnershipTransferWireIdentity[] = []
  let starting = true
  const assertUnavailableReservations = () => {
    for (const identity of unavailableSources) {
      runtime.assertPublishedDelegatedPtyReserved(identity)
    }
  }
  const orchestrationRecovery = installOrcadOrchestrationRecovery({
    lifetime,
    refreshAuthority: async () => {
      try {
        await runtime.refreshRestoredOrchestrationAuthority()
      } catch (error) {
        if (
          !starting ||
          unavailableSources.length === 0 ||
          !(error instanceof Error) ||
          error.message !== 'terminal_liveness_unavailable'
        ) {
          throw error
        }
        assertUnavailableReservations()
      }
    },
    reconcileWorkers: () => runtime.reconcileLegacyWorkerTerminals(),
    onError: (error) => console.error('[orcad] orchestration recovery failed:', error)
  })
  const bindDelegatedProvider = createOrcadDelegatedProviderBinding(runtime, getLocalPtyProvider)
  const delegatedLifecycle = installOrcadDelegatedRecovery({
    enabled: isPtyOwnershipTransferMutationEnabled(),
    registry: runtime.getPtyOwnershipTransferDestinationRegistry(),
    lifetime,
    bindConnection: (identity, connection) => {
      const remove = bindDelegatedProvider(identity, connection)
      orchestrationRecovery.notify()
      return remove
    },
    onExit: (event) => runtime.acceptDelegatedPtyExit(event),
    recoverRetirement: runtime.recoverDelegatedPtyRetirement,
    onExecutionState: (identity, claim) => {
      if (runtime.acceptDelegatedPtyExecutionState(identity, claim)) {
        orchestrationRecovery.notify()
      }
    },
    providerModel: {
      snapshot: (identity, options) =>
        runtime.serializePublishedDelegatedPtyModel(identity, options),
      sequence: (identity) => runtime.getPtyOutputSequence(identity.terminalId)
    },
    prepareModelFrame: (identity, frame, signal) =>
      runtime.prepareDelegatedPtyModelFrame(identity, frame, signal),
    initializeModel: async (identity, signal) => {
      runtime.registerPublishedDelegatedPty(identity)
      await runtime.initializeDelegatedPtyOwnershipModel(identity, signal)
    },
    onError: (identity, error) =>
      console.error('[orcad] delegated connection recovery failed:', {
        bridgeId: identity.bridgeId,
        error
      })
  })
  // Fence recovery before connection teardown publishes its final liveness changes.
  lifetime.add(async () => {
    await Promise.all([orchestrationRecovery.stop(), runtime.stopLegacyWorkerTerminalRecovery()])
  })
  if (delegatedLifecycle) {
    lifetime.add(runtime.installCapturedPtyDestinationLifecycle(delegatedLifecycle))
    unavailableSources = await delegatedLifecycle.settleInitialRecovery(true)
    assertUnavailableReservations()
  }
  try {
    await orchestrationRecovery.start()
  } finally {
    starting = false
  }
}
