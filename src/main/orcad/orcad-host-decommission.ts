import type { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import { configureOrcadDecommission } from './orcad-decommission'
import type { OrcadNativeDecommissionResult } from './orcad-daemon-supervision'
import type { OrcadManagedStopInstance } from '../../shared/orcad-managed-stop-instance'
import {
  sameOrcadManagedStopAuthority,
  type OrcadManagedStopAuthority,
  type OrcadManagedStopRuntimeIdentity
} from '../../shared/orcad-managed-stop-authority'

const pendingStops = new WeakMap<
  PtyOwnershipTransferDestinationRuntimeRegistry,
  { authority?: OrcadManagedStopAuthority; promise: Promise<OrcadDecommissionResult> }
>()

export function configureOrcadHostDecommission(
  runtime: {
    getPtyOwnershipTransferDestinationRegistry(): PtyOwnershipTransferDestinationRuntimeRegistry | null
  },
  retireDaemon: () => Promise<OrcadNativeDecommissionResult>,
  identity?: OrcadManagedStopRuntimeIdentity,
  instance?: OrcadManagedStopInstance
): void {
  configureOrcadDecommission(
    (authority) =>
      decommissionOrcadHostIfIdle(
        runtime.getPtyOwnershipTransferDestinationRegistry(),
        retireDaemon,
        authority
      ),
    identity,
    instance,
    (authority) => {
      const registry = runtime.getPtyOwnershipTransferDestinationRegistry()
      if (!registry) {
        throw new Error('destination registry unavailable')
      }
      registry.assertConfirmedNativeReopeningFor(authority)
    }
  )
}

export function decommissionOrcadHostIfIdle(
  registry: PtyOwnershipTransferDestinationRuntimeRegistry | null,
  retireDaemon: () => Promise<OrcadNativeDecommissionResult>,
  authority?: OrcadManagedStopAuthority
): Promise<OrcadDecommissionResult> {
  const requested = authority === undefined ? undefined : Object.freeze({ ...authority })
  if (!registry) {
    return finishDecommission(null, retireDaemon, requested)
  }
  const pending = pendingStops.get(registry)
  if (pending) {
    const sameAuthority =
      pending.authority === undefined || requested === undefined
        ? pending.authority === requested
        : sameOrcadManagedStopAuthority(pending.authority, requested)
    return sameAuthority
      ? pending.promise
      : Promise.resolve({
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'orcad_decommission_authority_conflict',
          reason: 'Another managed-stop authority already owns this pending retirement.'
        })
  }
  const stopping = finishDecommission(registry, retireDaemon, requested).finally(() => {
    pendingStops.delete(registry)
  })
  pendingStops.set(registry, { authority: requested, promise: stopping })
  return stopping
}

async function finishDecommission(
  registry: PtyOwnershipTransferDestinationRuntimeRegistry | null,
  retireDaemon: () => Promise<OrcadNativeDecommissionResult>,
  authority?: OrcadManagedStopAuthority
): Promise<OrcadDecommissionResult> {
  try {
    if (!registry) {
      throw new Error('destination registry unavailable')
    }
    registry.fenceAdmissionForDecommission(authority)
  } catch {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_transfer_unverifiable',
      reason:
        'Ownership transfers are active or their durable retirement cannot be verified. Finish transfer recovery before stopping this host.'
    }
  }
  // Native retirement can partially fence admission even when its reply is lost.
  const { admissionReopened, ...result } = await retireDaemon()
  if (result.outcome === 'refused' && admissionReopened === true) {
    try {
      registry.reopenAdmissionAfterConfirmedNativeRefusal(authority)
      return { ...result, terminalAdmission: 'open' }
    } catch {
      // Keep the in-memory fence until the reopening record is durably acknowledged.
      return {
        ...result,
        verdict: 'unverifiable',
        terminalAdmission: 'fenced',
        reason: `${result.reason} Ownership-transfer admission remains fenced in this runtime because durable reopening could not be confirmed.`
      }
    }
  }
  // Legacy clients release their activation lock on `live` without checking admission.
  return result.outcome === 'refused'
    ? {
        ...result,
        verdict: 'unverifiable',
        terminalAdmission: 'fenced',
        reason: `${result.reason} Ownership-transfer admission remains durably fenced pending managed-stop recovery.`
      }
    : result
}
