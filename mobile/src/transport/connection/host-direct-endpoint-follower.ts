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
import { openAuthenticatedDirectEndpoint } from '../relay/mobile-direct-endpoint-probe'
import { directProbeTimeoutMsForEndpoint } from '../relay/mobile-direct-return-probe'
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

// A replacement that did not answer is not dialed again on every screen focus.
const FAILED_REPLACEMENT_RETRY_MS = 60_000

export type HostDirectEndpointFollower = {
  /** The saved direct endpoint, moved once the desktop's replacement answered from this phone. */
  directEndpoint(): string
  onConnected(): void
  refresh(): void
  /** Abort a verification dial in flight; the next foreground refresh tries again. */
  cancel(): void
  stop(): void
}

/**
 * Follows a desktop's moved direct address. Only the desktop can say an address is no longer its
 * own; its replacement is saved only after this phone authenticates there, so an address that left
 * for a moment, or one this phone cannot reach, never strands the row.
 */
export function createHostDirectEndpointFollower(args: {
  client: StableLogicalRpcClient
  hostId: string
  saved: HostDirectEndpointFields
  openDirect: (endpoint: string) => RpcClient
  /** Background work can wait: the resume nudge asks again. */
  isForeground: () => boolean
  now: () => number
}): HostDirectEndpointFollower {
  const { client, hostId } = args
  // The last settled host list is storage as of its read, until a write clears it; the opener's copy may be older.
  const settledRow = peekHosts()?.find((host) => host.id === hostId)
  const { endpoint, directEndpointOrigin } = settledRow ?? args.saved
  let saved: HostDirectEndpointFields = { endpoint, directEndpointOrigin }
  let syncedWithStorage = settledRow !== undefined
  // After one answer only a desktop-owned row can change, so manual and unknown rows stop asking.
  let answered = false
  let failedReplacement: { endpoint: string; at: number } | null = null
  let connection = 0
  let verifying: AbortController | null = null
  let stopped = false
  let unsupported = false
  let inFlight = false
  // A cutover can publish the new session's connected edge while the old session's read is pending.
  let requestedWhileInFlight = false

  const adoptSaved = (fields: HostDirectEndpointFields | null): void => {
    if (fields) {
      saved = fields
    }
  }
  const tryReplacement = async (replacement: string): Promise<void> => {
    if (
      stopped ||
      !args.isForeground() ||
      (failedReplacement?.endpoint === replacement &&
        args.now() - failedReplacement.at < FAILED_REPLACEMENT_RETRY_MS)
    ) {
      return
    }
    const attempt = connection
    const controller = new AbortController()
    verifying = controller
    const reached = await openAuthenticatedDirectEndpoint(
      () => args.openDirect(replacement),
      directProbeTimeoutMsForEndpoint(replacement),
      controller.signal
    ).finally(() => {
      if (verifying === controller) {
        verifying = null
      }
    })
    if (!reached) {
      // A miss on an older connection says nothing about the network the new one is on.
      if (attempt === connection && !controller.signal.aborted) {
        failedReplacement = { endpoint: replacement, at: args.now() }
      }
      return
    }
    // Return probes dial the saved endpoint and own promotion; this dial only proved it reachable.
    reached.close()
    failedReplacement = null
    adoptSaved(await adoptHostDirectEndpoint(hostId, saved.endpoint, replacement))
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
    answered = true
    const replacement = directEndpointCandidate(saved, endpoints)
    if (replacement !== null) {
      await tryReplacement(replacement)
    }
  }
  const refresh = (): void => {
    if (inFlight) {
      requestedWhileInFlight = true
      return
    }
    if (
      stopped ||
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
  return {
    directEndpoint: () => saved.endpoint,
    onConnected() {
      // A new connection may be on a new network, where an earlier miss can now answer.
      connection += 1
      unsupported = false
      failedReplacement = null
      refresh()
    },
    refresh,
    cancel() {
      verifying?.abort()
    },
    stop() {
      stopped = true
      verifying?.abort()
    }
  }
}
