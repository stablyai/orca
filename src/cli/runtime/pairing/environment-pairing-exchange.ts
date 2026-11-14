import { parsePairingCode } from '../../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { exchangeRemotePairingTicket } from '../../../shared/remote-runtime/pairing/remote-pairing-ticket-exchange'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import { RuntimeClientError } from '../connection/types'

// `environment add` works offline; a short probe keeps an unreachable host from stalling it.
const STATUS_PROBE_TIMEOUT_MS = 5_000

function pairingCodeRefused(): RuntimeClientError {
  return new RuntimeClientError(
    'unauthorized',
    'The host refused this pairing code. It may have expired or already been used by another device. Show a new pairing code on the host (`orca pair`, or Settings → Remote Orca Servers in Orca) and run `orca environment add` again.'
  )
}

/** Best effort: the pairing code to save, exchanged for a token only this machine holds when the host supports it. */
export async function exchangeCliPairingCode(
  pairingCode: string,
  send: typeof sendRemoteRuntimeRequestOnSocket = sendRemoteRuntimeRequestOnSocket
): Promise<string> {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    // The store reports the invalid code.
    return pairingCode
  }
  let status: RuntimeRpcResponse<RuntimeStatus>
  try {
    status = await send<RuntimeStatus>(
      pairedRuntimeConnectionFromOffer(offer),
      'status.get',
      undefined,
      STATUS_PROBE_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  } catch (error) {
    // A reachable host that refuses the code: saving it would only fail later.
    if (error instanceof RemoteRuntimeClientError && error.code === 'unauthorized') {
      throw pairingCodeRefused()
    }
    return pairingCode
  }
  if (!status.ok) {
    if (status.error.code === 'unauthorized') {
      throw pairingCodeRefused()
    }
    return pairingCode
  }
  return exchangeRemotePairingTicket({
    pairingCode,
    offer,
    hostCapabilities: status.result.capabilities,
    send
  })
}
