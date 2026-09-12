import { app } from 'electron'
import { join } from 'node:path'
import { getLocalPtyProvider, subscribeLocalPtyProviderChanges } from '../ipc/pty'
import {
  type RuntimePtyOwnershipTransferReadOnlySource,
  createReconciledRuntimePtyOwnershipTransferReadOnlySource
} from '../providers/runtime-pty-ownership-transfer-read-only-source'
import { loadOrCreateRuntimeIdentity } from '../runtime/runtime-identity'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { getRuntimeEnvironmentTransportGeneration } from '../ipc/runtime-environment-transport-generation'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  createPairedRuntimePtyOwnershipTransferRpc,
  createPairedRuntimePtyOwnershipTransferSubscription
} from '../runtime/paired-runtime-pty-ownership-transfer-rpc'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { mainProcessState as state } from './main-process-state'

export async function initializeMainProcessPtyOwnership() {
  const profile = state.activeOrcaProfile
  if (!profile) {
    throw new Error('Active profile must be initialized before runtime')
  }
  const runtimeId = loadOrCreateRuntimeIdentity(
    join(profile.profileDirectory, 'runtime-identity.json')
  )
  let source: RuntimePtyOwnershipTransferReadOnlySource | null = null
  try {
    const binding = await createReconciledRuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory: join(profile.profileDirectory, 'pty-ownership-transfer-source'),
      runtimeId,
      onError: (error) =>
        console.warn('[pty-ownership-transfer] local provider reconciliation failed:', error),
      mutationEnabled: () => isPtyOwnershipTransferMutationEnabled(),
      authorizeMutationRequest: (method, request, authBinding) =>
        source?.authorizeMutationRequest(method, request, authBinding) ?? false,
      getProvider: getLocalPtyProvider,
      subscribe: subscribeLocalPtyProviderChanges
    })
    source = binding.source
    app.once('will-quit', () => {
      binding.unsubscribe()
      binding.source.dispose()
    })
  } catch (error) {
    console.warn('[pty-ownership-transfer] local source state is unavailable:', error)
  }
  const paired = {
    userDataPath: app.getPath('userData'),
    resolveEnvironment,
    getTransportGeneration: getRuntimeEnvironmentTransportGeneration
  }
  return {
    runtimeId,
    getLocalPtyOwnershipTransferReadOnlySource: () => source,
    getLocalPtyOwnershipTransferSource: () => source?.getMutationSource() ?? null,
    ptyOwnershipTransferMutationEnabled: () => isPtyOwnershipTransferMutationEnabled(),
    callPairedRuntimePtyOwnershipTransferRpc: createPairedRuntimePtyOwnershipTransferRpc({
      ...paired,
      callRuntimeEnvironment
    }),
    subscribePairedRuntimePtyOwnershipTransfer:
      createPairedRuntimePtyOwnershipTransferSubscription(paired)
  }
}
