import { refreshEnvironmentFromResumePairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-resume-pairing'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'

const SAVED_PAIRING_PROBE_TIMEOUT_MS = 10_000

// The newest resume per environment. A background confirmation may only re-pair for the resume that
// started it: a later resume (Restart right after a wake) owns the environment's pairing now.
const latestResume = new Map<string, number>()
let resumeSequence = 0

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
  /**
   * Confirm a kept token off the critical path: answer at once and re-pair later only if the
   * server turns out to have lost the device. For wakes, where every connection setup is latency.
   */
  confirmInBackground?: boolean
  /** Called when a background confirmation had to re-pair (the environment's pairing changed). */
  onRepairedInBackground?: (environment: KnownRuntimeEnvironment) => void
  now?: number
}): Promise<ResumedRuntimePairingOutcome> {
  const resume = ++resumeSequence
  latestResume.set(args.environmentId, resume)
  const { repairFromFreshOffer, ...refreshed } = refreshEnvironmentFromResumePairingCode(
    args.userDataPath,
    args.environmentId,
    { pairingCode: args.pairingCode, now: args.now }
  )
  // Why also on an unchanged endpoint: the VM restarted, so any open socket is already dead.
  if (!refreshed.reusedPairing) {
    void args.invalidateTransport(args.environmentId)
    return refreshed
  }
  // Why before the probe: a kept token is almost always still valid, so the real connection dials
  // while the probe confirms it instead of after (one connection setup off the wake path). In the
  // rare case the server lost the device, the re-pair below drops that socket and dials again.
  void args.invalidateTransport(args.environmentId)
  const isCurrent = (): boolean => latestResume.get(args.environmentId) === resume
  // A stale confirmation must not overwrite the pairing a newer resume wrote.
  const guardedRepair = (): KnownRuntimeEnvironment =>
    isCurrent() ? repairFromFreshOffer() : refreshed.environment
  const confirmed = confirmSavedPairing(refreshed, guardedRepair, args.probeSavedPairing).then(
    (outcome) => {
      if (outcome.environment === refreshed.environment) {
        // Kept, or superseded by a newer resume before the re-pair: nothing changed here.
        return { ...outcome, reusedPairing: true }
      }
      void args.invalidateTransport(args.environmentId)
      return outcome
    }
  )
  if (!args.confirmInBackground) {
    return confirmed
  }
  void confirmed
    .then((outcome) => {
      if (!outcome.reusedPairing) {
        args.onRepairedInBackground?.(outcome.environment)
      }
    })
    .catch(() => undefined)
  return refreshed
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

/** The standalone saved-pairing probe (one connection setup); throws `unauthorized` on a refused token. */
export async function probeSavedPairing(connection: PairedRuntimeConnection): Promise<void> {
  const response = await sendRemoteRuntimeRequestOnSocket(
    connection,
    'status.get',
    undefined,
    SAVED_PAIRING_PROBE_TIMEOUT_MS,
    undefined,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    undefined,
    undefined
  )
  if (!response.ok && response.error.code === 'unauthorized') {
    throw new RemoteRuntimeClientError('unauthorized', response.error.message)
  }
}
