import { parsePairingCode } from '../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { exchangeRemotePairingTicket } from '../../shared/remote-runtime/pairing/remote-pairing-ticket-exchange'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'

// `environment add` works offline; a short probe keeps an unreachable host from stalling it.
const STATUS_PROBE_TIMEOUT_MS = 5_000

/** Best effort: the pairing code to save, exchanged for a token only this machine holds when the host supports it. */
export async function exchangeCliPairingCode(
  pairingCode: string,
  send: typeof sendRemoteRuntimeRequest = sendRemoteRuntimeRequest
): Promise<string> {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    // The store reports the invalid code.
    return pairingCode
  }
  try {
    const status = await send<RuntimeStatus>(
      pairedRuntimeConnectionFromOffer(offer),
      'status.get',
      undefined,
      STATUS_PROBE_TIMEOUT_MS
    )
    if (!status.ok) {
      return pairingCode
    }
    return await exchangeRemotePairingTicket({
      pairingCode,
      offer,
      hostCapabilities: status.result.capabilities,
      send
    })
  } catch {
    return pairingCode
  }
}
