import {
  PAIRING_GET_DIRECT_ENDPOINTS_METHOD,
  PairingGetDirectEndpointsResultSchema
} from '../../../../src/shared/remote-runtime/pairing/pairing-direct-endpoints-contract'
import {
  directEndpointCandidate,
  directEndpointListedByHost,
  type HostDirectEndpointFields
} from '../../host-catalog/host-direct-endpoint-refresh'
import {
  adoptHostDirectEndpoint,
  markHostDirectEndpointListed
} from '../../host-catalog/host-direct-endpoint-persistence'
import { peekHosts } from '../../host-catalog/host-store'
import { isPairingRelayRpcUnavailable } from '../../pairing/pairing-relay-rpc-unavailable'
import { bindDeferredRpcOperation, defineRpcOperation } from '../rpc/rpc-operation'
import { rpcResultVariant } from '../rpc/rpc-operation-result-reader'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

const pairingDirectEndpointsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.direct-endpoints',
    method: PAIRING_GET_DIRECT_ENDPOINTS_METHOD,
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('direct-endpoints', PairingGetDirectEndpointsResultSchema)
  })
)

export type HostDirectEndpointFollower = {
  /** Where the desktop should answer now: an unverified replacement, else the saved endpoint. */
  directEndpoint(): string
  /** Open a return-probe dial; a direct win at the replacement proves it, a failure tries the other. */
  dial(open: (endpoint: string) => RpcClient): RpcClient
  onNetworkArrival(): void
  onConnected(): void
  refresh(): void
}

/** Follows a desktop's moved direct address: dial the desktop's replacement, save it once it answers. */
export function createHostDirectEndpointFollower(args: {
  client: StableLogicalRpcClient
  hostId: string
  saved: HostDirectEndpointFields
  /** Background work can wait: the resume nudge asks again. */
  isForeground: () => boolean
}): HostDirectEndpointFollower {
  const { client, hostId } = args
  // The last settled host list is storage as of its read, until a write clears it; the opener's copy may be older.
  const settledRow = peekHosts()?.find((host) => host.id === hostId)
  const { endpoint, directEndpointOrigin } = settledRow ?? args.saved
  let saved: HostDirectEndpointFields = { endpoint, directEndpointOrigin }
  let syncedWithStorage = settledRow !== undefined
  // After one answer only a desktop-owned row can change, so manual and unknown rows stop asking.
  let answered = false
  let candidate: string | null = null
  let lastDialed: string | null = null
  // After a failed dial, try the other of candidate/saved: an address back from a blip answers there.
  let dialSaved = false
  let unsupported = false
  let inFlight = false
  // A cutover can publish the new session's connected edge while the old session's read is pending.
  let requestedWhileInFlight = false

  const adoptSaved = (fields: HostDirectEndpointFields | null): void => {
    if (fields) {
      saved = fields
    }
  }
  const read = async (): Promise<void> => {
    const reply = await pairingDirectEndpointsRead.request(client, {})
    if (isPairingRelayRpcUnavailable(reply)) {
      // Older desktops lack the method; ask again only after the next connection.
      unsupported = true
      return
    }
    const { endpoints } = pairingDirectEndpointsRead.interpret(reply)
    if (!syncedWithStorage || directEndpointListedByHost(saved, endpoints)) {
      adoptSaved(await markHostDirectEndpointListed(hostId, endpoints))
      syncedWithStorage = true
    }
    const next = directEndpointCandidate(saved, endpoints)
    if (next !== candidate) {
      candidate = next
      dialSaved = false
    }
    answered = true
  }
  const refresh = (): void => {
    if (inFlight) {
      requestedWhileInFlight = true
      return
    }
    if (
      unsupported ||
      (answered && saved.directEndpointOrigin !== 'host') ||
      !args.isForeground() ||
      client.getState() !== 'connected'
    ) {
      return
    }
    inFlight = true
    void read()
      .catch(() => {
        // Best effort: the next connect or foreground asks again.
      })
      .finally(() => {
        inFlight = false
        if (requestedWhileInFlight) {
          requestedWhileInFlight = false
          refresh()
        }
      })
  }
  let adopting = false
  const saveVerifiedCandidate = (): void => {
    const verified = candidate
    if (
      adopting ||
      verified === null ||
      lastDialed !== verified ||
      client.getActivePath() === 'relay'
    ) {
      return
    }
    adopting = true
    // This connection authenticated at the replacement, so it is reachable from here: keep it.
    void adoptHostDirectEndpoint(hostId, saved.endpoint, verified)
      .then((fields) => {
        adoptSaved(fields)
        if (candidate === verified && saved.endpoint === verified) {
          candidate = null
        }
      })
      .catch(() => {})
      .finally(() => {
        adopting = false
      })
  }
  const directEndpoint = (): string => candidate ?? saved.endpoint
  return {
    directEndpoint,
    dial(open) {
      const endpoint = candidate !== null && dialSaved ? saved.endpoint : directEndpoint()
      lastDialed = endpoint
      const client = open(endpoint)
      // Keep dialing whichever answered; hysteresis needs consecutive wins at one address.
      const stop = client.onStateChange((state) => {
        if (state === 'connected') {
          stop()
        } else if (state === 'disconnected' || state === 'auth-failed') {
          stop()
          if (lastDialed === endpoint && candidate !== null) {
            dialSaved = endpoint !== saved.endpoint
          }
        }
      })
      return client
    },
    onNetworkArrival() {
      // A dial aborted by the network change is not evidence against the replacement.
      dialSaved = false
    },
    onConnected() {
      unsupported = false
      saveVerifiedCandidate()
      refresh()
    },
    refresh
  }
}
