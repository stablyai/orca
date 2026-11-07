import { refreshEnvironmentFromResumePairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-resume-pairing'
import {
  resolveEnvironmentPairingOffer,
  updateEnvironmentFromPairingCode
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairingOffer } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'

const SAVED_PAIRING_PROBE_TIMEOUT_MS = 10_000

export type ResumedRuntimePairingOutcome = {
  environment: KnownRuntimeEnvironment
  reusedPairing: boolean
  endpointChanged: boolean
}

/**
 * Points a resumed recipe VM's server environment at its new endpoint. Keeps the saved device
 * token while the host key is unchanged and the server still accepts it; otherwise re-pairs from
 * the resume's fresh code.
 */
export async function applyResumedRuntimePairing(args: {
  userDataPath: string
  environmentId: string
  pairingCode: string
  invalidateTransport: (environmentId: string) => unknown
  probeSavedPairing?: (offer: PairingOffer) => Promise<unknown>
  now?: number
}): Promise<ResumedRuntimePairingOutcome> {
  const refreshed = refreshEnvironmentFromResumePairingCode(args.userDataPath, args.environmentId, {
    pairingCode: args.pairingCode,
    now: args.now
  })
  // Why also on an unchanged endpoint: the VM restarted, so any open socket is already dead.
  void args.invalidateTransport(args.environmentId)
  if (!refreshed.reusedPairing) {
    return refreshed
  }
  const probe = args.probeSavedPairing ?? probeSavedPairing
  try {
    await probe(resolveEnvironmentPairingOffer(args.userDataPath, args.environmentId))
  } catch (error) {
    // Only a rejected token falls back; an unreachable server would fail the fresh pairing too.
    if (!(error instanceof RemoteRuntimeClientError) || error.code !== 'unauthorized') {
      return refreshed
    }
    // The server kept its key but lost the saved device (e.g. its device list was reset).
    const environment = updateEnvironmentFromPairingCode(args.userDataPath, args.environmentId, {
      pairingCode: args.pairingCode,
      now: args.now
    })
    void args.invalidateTransport(args.environmentId)
    return { environment, reusedPairing: false, endpointChanged: refreshed.endpointChanged }
  }
  return refreshed
}

async function probeSavedPairing(offer: PairingOffer): Promise<void> {
  const response = await sendRemoteRuntimeRequest(
    pairedRuntimeConnectionFromOffer(offer),
    'status.get',
    undefined,
    SAVED_PAIRING_PROBE_TIMEOUT_MS,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok && response.error.code === 'unauthorized') {
    throw new RemoteRuntimeClientError('unauthorized', response.error.message)
  }
}
