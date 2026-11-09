import { refreshEnvironmentFromResumePairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-resume-pairing'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
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
  probeSavedPairing?: (connection: PairedRuntimeConnection) => Promise<unknown>
  now?: number
}): Promise<ResumedRuntimePairingOutcome> {
  const { repairFromFreshOffer, ...refreshed } = refreshEnvironmentFromResumePairingCode(
    args.userDataPath,
    args.environmentId,
    { pairingCode: args.pairingCode, now: args.now }
  )
  const outcome = refreshed.reusedPairing
    ? await confirmSavedPairing(refreshed, repairFromFreshOffer, args.probeSavedPairing)
    : refreshed
  // Why also on an unchanged endpoint: the VM restarted, so any open socket is already dead.
  // Why after the probe: reconnecting first would dial with a token about to be replaced.
  void args.invalidateTransport(args.environmentId)
  return outcome
}

async function confirmSavedPairing(
  refreshed: ResumedRuntimePairingOutcome,
  repairFromFreshOffer: () => KnownRuntimeEnvironment,
  probe: (connection: PairedRuntimeConnection) => Promise<unknown> = probeSavedPairing
): Promise<ResumedRuntimePairingOutcome> {
  try {
    await probe(getPreferredPairedRuntimeConnection(refreshed.environment))
    return refreshed
  } catch (error) {
    // Only a rejected token falls back; an unreachable server would fail the fresh pairing too.
    if (!(error instanceof RemoteRuntimeClientError) || error.code !== 'unauthorized') {
      return refreshed
    }
    // The server kept its key but lost the saved device (e.g. its device list was reset).
    return { ...refreshed, environment: repairFromFreshOffer(), reusedPairing: false }
  }
}

async function probeSavedPairing(connection: PairedRuntimeConnection): Promise<void> {
  const response = await sendRemoteRuntimeRequest(
    connection,
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
