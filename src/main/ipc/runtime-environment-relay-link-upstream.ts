import { randomUUID } from 'node:crypto'
import { MOBILE_RELAY_CLOSE_CODE } from '../../shared/mobile-relay-close-codes'
import {
  PairingGetEndpointsResultSchema,
  type MobileRelayEndpoint
} from '../../shared/mobile-relay-credential-contract'
import type { RuntimeEnvironmentRelayRoute } from '../../shared/runtime-environments'
import {
  resolveRuntimeRelayEndpoint,
  RuntimeRelayResolveError
} from './runtime-environment-relay-director'
import { openRuntimeRelayLink, type RuntimeRelayLinkClose } from './runtime-environment-relay-link'
import { RuntimeRelayLinkRpc } from './runtime-environment-relay-rpc'
import type {
  RuntimeRelayBridgeUpstream,
  RuntimeRelayBridgeUpstreamEvents,
  RuntimeRelayBridgeUpstreamOpen
} from './runtime-environment-relay-upstream'

// Why: a confirmed resume renews to the cell's full TTL (30 days); confirming at most daily keeps it alive cheaply.
const RESUME_RENEWAL_REMAINING_MS = 29 * 24 * 60 * 60 * 1000

export type RuntimeRelayBridgeRelayTarget = {
  deviceToken: string
  hostPublicKey: Uint8Array
  readRoute: () => RuntimeEnvironmentRelayRoute | null
  writeRoute: (
    update: (route: RuntimeEnvironmentRelayRoute) => RuntimeEnvironmentRelayRoute
  ) => void
  connectUrl?: (baseUrl: string, relayHostId: string) => string
}

type RelayDial =
  | { kind: 'ready'; upstream: RuntimeRelayBridgeUpstream; rpc: RuntimeRelayLinkRpc }
  | { kind: 'failed'; close: RuntimeRelayLinkClose }

/** Resumes the stored Relay credential, following one director move before giving up. */
export async function openRelayBridgeUpstream(
  target: RuntimeRelayBridgeRelayTarget,
  events: RuntimeRelayBridgeUpstreamEvents
): Promise<RuntimeRelayBridgeUpstreamOpen> {
  const route = target.readRoute()
  if (!route) {
    return { ok: false, unauthorized: false, message: 'This server has no Orca Relay route.' }
  }
  let endpoint = route.endpoint
  for (let attempt = 0; ; attempt++) {
    const dialed = await dialRelay(target, endpoint, route.credential.token, events)
    if (dialed.kind === 'ready') {
      await confirmResumeIfDue(target, dialed.rpc)
      return { ok: true, upstream: dialed.upstream }
    }
    const { close } = dialed
    const moved =
      close.kind === 'refused' &&
      (close.code === MOBILE_RELAY_CLOSE_CODE.WRONG_CELL ||
        close.code === MOBILE_RELAY_CLOSE_CODE.DRAINING)
    if (!moved || attempt > 0) {
      return describeRelayFailure(close)
    }
    try {
      const resolved = await resolveRuntimeRelayEndpoint(endpoint, route.credential.token)
      endpoint = resolved
      target.writeRoute((current) => ({ ...current, endpoint: resolved }))
    } catch (error) {
      // Why: a cell answers an unknown or revoked resume token with WRONG_CELL; only the director names it.
      if (error instanceof RuntimeRelayResolveError && error.status === 401) {
        return {
          ok: false,
          unauthorized: true,
          message: 'Orca Relay no longer accepts this access.'
        }
      }
      return {
        ok: false,
        unauthorized: false,
        message: `Orca Relay could not locate this server (${error instanceof Error ? error.message : String(error)}).`
      }
    }
  }
}

function dialRelay(
  target: RuntimeRelayBridgeRelayTarget,
  endpoint: MobileRelayEndpoint,
  token: string,
  events: RuntimeRelayBridgeUpstreamEvents
): Promise<RelayDial> {
  return new Promise((resolve) => {
    let ready = false
    const link = openRuntimeRelayLink({
      baseUrl: endpoint.cellUrl,
      relayHostId: endpoint.relayHostId,
      hostPublicKey: target.hostPublicKey,
      deviceToken: target.deviceToken,
      credential: { kind: 'resume', token },
      connectUrl: target.connectUrl,
      handlers: {
        onAuthenticated: () => {
          ready = true
          resolve({ kind: 'ready', upstream, rpc })
        },
        onText: (plaintext) => {
          if (!rpc.handleText(plaintext)) {
            events.onText(plaintext)
          }
        },
        onBinary: (bytes) => events.onBinary(bytes),
        onPong: () => events.onPong(),
        onClose: (close) => {
          rpc.rejectAll(new Error('Orca Relay link closed'))
          if (!ready) {
            resolve({ kind: 'failed', close })
            return
          }
          const { code, reason } = relayCloseForClient(close)
          events.onClose(code, reason)
        }
      }
    })
    const rpc = new RuntimeRelayLinkRpc((plaintext) => link.sendText(plaintext), target.deviceToken)
    const upstream: RuntimeRelayBridgeUpstream = {
      route: 'relay',
      // Why: E2EE v2 auth cannot carry the client's capabilities, so they follow as an RPC.
      authenticate: async (clientCapabilities) => {
        if (clientCapabilities.length === 0) {
          return 'authenticated'
        }
        try {
          const response = await rpc.request('runtime.clientCapabilities.update', {
            clientCapabilities
          })
          return response.ok ? 'authenticated' : 'failed'
        } catch {
          return 'failed'
        }
      },
      sendText: (plaintext) => link.sendText(plaintext),
      sendBinary: (bytes) => link.sendBinary(bytes),
      ping: () => link.ping(),
      close: () => link.close()
    }
  })
}

async function confirmResumeIfDue(
  target: RuntimeRelayBridgeRelayTarget,
  rpc: RuntimeRelayLinkRpc
): Promise<void> {
  const route = target.readRoute()
  if (!route || route.credential.expiresAt - Date.now() > RESUME_RENEWAL_REMAINING_MS) {
    return
  }
  try {
    const response = await rpc.request('pairing.getEndpoints', {
      resumeConfirmReqId: `resume-${randomUUID()}`
    })
    const parsed = response.ok ? PairingGetEndpointsResultSchema.safeParse(response.result) : null
    const confirmation = parsed?.success ? parsed.data.resumeConfirmation : undefined
    if (!parsed?.success || !confirmation?.renewed) {
      return
    }
    target.writeRoute((current) => ({
      endpoint: parsed.data.relay ?? current.endpoint,
      credential: {
        ...current.credential,
        version: confirmation.currentVersion,
        expiresAt: confirmation.resumeExpiresAt
      }
    }))
  } catch (error) {
    // Why: renewal is best effort; the stored credential stays valid and the next connect retries.
    console.warn(
      '[runtime-environment-relay] Resume confirmation failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function describeRelayFailure(close: RuntimeRelayLinkClose): RuntimeRelayBridgeUpstreamOpen {
  if (close.kind === 'unauthorized') {
    return { ok: false, unauthorized: true, message: 'The Orca server revoked this access.' }
  }
  if (close.kind === 'refused' && close.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL) {
    // Why: the host revokes the cloud credential with the grant, so a refused credential means re-pair.
    return { ok: false, unauthorized: true, message: 'Orca Relay no longer accepts this access.' }
  }
  return { ok: false, unauthorized: false, message: relayCloseForClient(close).reason }
}

function relayCloseForClient(close: RuntimeRelayLinkClose): { code: number; reason: string } {
  switch (close.kind) {
    case 'refused':
      return {
        code: close.code,
        reason:
          close.code === MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE
            ? 'The Orca server is not connected to Orca Relay'
            : close.code === MOBILE_RELAY_CLOSE_CODE.LIMIT_EXCEEDED
              ? 'Orca Relay connection limit reached for this server'
              : 'Orca Relay refused the connection'
      }
    case 'unauthorized':
      return { code: 4001, reason: 'Unauthorized' }
    case 'closed':
      // Why: 1005/1006/1015 are receive-only codes; a peer may not send them.
      return {
        code:
          close.code === 1000 || close.code === 1001 || (close.code >= 4000 && close.code < 5000)
            ? close.code
            : 1011,
        reason: close.reason || 'Orca Relay connection closed'
      }
    case 'moved':
      return { code: 1011, reason: 'Orca Relay moved this server' }
    case 'identity':
      return { code: 1011, reason: 'The server behind Orca Relay does not match this pairing' }
    case 'protocol':
      return { code: 1011, reason: close.message }
  }
}
