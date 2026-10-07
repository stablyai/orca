import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { publicKeyFromBase64 } from '../../shared/e2ee-crypto'
import { MOBILE_RELAY_CLOSE_CODE } from '../../shared/mobile-relay-close-codes'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema
} from '../../shared/mobile-relay-credential-contract'
import type { PairingRelay } from '../../shared/mobile-relay-pairing-offer'
import type { PairingOffer } from '../../shared/pairing'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure
} from '../../shared/remote-pairing-verification'
import type { RuntimeEnvironmentRelayRoute } from '../../shared/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { deriveRelayHostId } from '../runtime/relay/relay-http-client'
import { openRuntimeRelayLink, type RuntimeRelayLinkClose } from './runtime-environment-relay-link'
import { RuntimeRelayLinkRpc } from './runtime-environment-relay-rpc'

export type RuntimeRelayPairingResult =
  | { ok: true; runtimeStatus: RuntimeStatus; route: RuntimeEnvironmentRelayRoute }
  | RemotePairingFailure

type InviteSession =
  | { kind: 'ready'; rpc: RuntimeRelayLinkRpc; close: () => void }
  | { kind: 'failed'; close: RuntimeRelayLinkClose }

// Why the text, not the bytes: the relay stores a digest of the serialized bearer it receives.
export function hashRuntimeRelayCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

/** Redeems a runtime Relay invite, verifies the server, and installs this client's own credential. */
export async function pairRuntimeEnvironmentThroughRelay(
  offer: PairingOffer,
  relay: PairingRelay,
  options: { connectUrl?: (baseUrl: string, relayHostId: string) => string } = {}
): Promise<RuntimeRelayPairingResult> {
  let hostPublicKey: Uint8Array
  try {
    hostPublicKey = publicKeyFromBase64(offer.publicKeyB64)
  } catch {
    return failure('access-link-invalid', 'This access link contains invalid connection details.')
  }
  // Why: a tampered link could aim Relay at another host; E2EE would refuse it later, but fail clearly now.
  if (deriveRelayHostId(hostPublicKey) !== relay.relayHostId) {
    return failure('access-link-invalid', 'This access link contains invalid Orca Relay details.')
  }
  const open = (baseUrl: string) =>
    openInviteSession(baseUrl, relay, hostPublicKey, offer.deviceToken, options.connectUrl)
  let session = await open(relay.cellUrl)
  if (session.kind === 'failed' && isCellMove(session.close)) {
    const director = await open(relay.directorUrl)
    if (director.kind === 'ready') {
      director.close()
    } else if (
      director.close.kind === 'moved' &&
      director.close.assignmentEpoch > relay.assignmentEpoch
    ) {
      session = await open(director.close.cellUrl)
    } else {
      // Why: a cell answers an expired or spent invite with WRONG_CELL; only the director names it.
      session = director
    }
  }
  if (session.kind === 'failed') {
    return describeInviteFailure(session.close)
  }
  try {
    return await installRelayCredential(session.rpc)
  } catch (error) {
    return failure(
      'connection-interrupted',
      `The Orca Relay connection was interrupted during verification (${error instanceof Error ? error.message : String(error)}).`
    )
  } finally {
    session.close()
  }
}

async function installRelayCredential(
  rpc: RuntimeRelayLinkRpc
): Promise<RuntimeRelayPairingResult> {
  const status = await rpc.request('status.get')
  if (!status.ok) {
    return failure('connection-interrupted', status.error.message)
  }
  const verified = verifyRemotePairingRuntimeStatus(status.result)
  if (!verified.ok) {
    return verified
  }
  const token = randomBytes(32).toString('base64url')
  const reqId = `install-${randomUUID()}`
  const installReply = await rpc.request('pairing.provisionRelay', {
    reqId,
    newResumeTokenHash: hashRuntimeRelayCredential(token)
  })
  if (!installReply.ok) {
    return failure(
      'connection-interrupted',
      `The Orca server did not issue an Orca Relay credential (${installReply.error.code}).`
    )
  }
  const installed = DeviceCredentialInstalledSchema.parse(installReply.result)
  const endpointsReply = await rpc.request('pairing.getEndpoints', { installReqId: reqId })
  const endpoints = endpointsReply.ok
    ? PairingGetEndpointsResultSchema.parse(endpointsReply.result)
    : null
  // Why: only the committed install record proves the cloud now accepts this token.
  if (
    endpoints?.installStatus?.state !== 'committed' ||
    endpoints.installStatus.result.reqId !== reqId ||
    !endpoints.relay
  ) {
    return failure('connection-interrupted', 'Orca Relay did not confirm the new credential.')
  }
  return {
    ok: true,
    runtimeStatus: verified.runtimeStatus,
    route: {
      endpoint: endpoints.relay,
      credential: { token, version: installed.currentVersion, expiresAt: installed.resumeExpiresAt }
    }
  }
}

function openInviteSession(
  baseUrl: string,
  relay: PairingRelay,
  hostPublicKey: Uint8Array,
  deviceToken: string,
  connectUrl: ((baseUrl: string, relayHostId: string) => string) | undefined
): Promise<InviteSession> {
  return new Promise((resolve) => {
    let ready = false
    const link = openRuntimeRelayLink({
      baseUrl,
      relayHostId: relay.relayHostId,
      hostPublicKey,
      deviceToken,
      credential: { kind: 'invite', token: relay.inviteToken },
      connectUrl,
      handlers: {
        onAuthenticated: () => {
          ready = true
          resolve({ kind: 'ready', rpc, close: () => link.close() })
        },
        onText: (plaintext) => rpc.handleText(plaintext),
        onBinary: () => {},
        onClose: (close) => {
          rpc.rejectAll(new Error('Orca Relay link closed'))
          if (!ready) {
            resolve({ kind: 'failed', close })
          }
        }
      }
    })
    const rpc = new RuntimeRelayLinkRpc((plaintext) => link.sendText(plaintext), deviceToken)
  })
}

function isCellMove(close: RuntimeRelayLinkClose): boolean {
  return (
    close.kind === 'refused' &&
    (close.code === MOBILE_RELAY_CLOSE_CODE.WRONG_CELL ||
      close.code === MOBILE_RELAY_CLOSE_CODE.DRAINING)
  )
}

function describeInviteFailure(close: RuntimeRelayLinkClose): RemotePairingFailure {
  if (close.kind === 'identity') {
    return failure(
      'host-identity-mismatch',
      'Orca Relay reached a server that does not match this access link.'
    )
  }
  if (
    close.kind === 'unauthorized' ||
    (close.kind === 'refused' && close.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
  ) {
    return failure(
      'access-link-invalid',
      'This Orca Relay link has expired or was already used. Generate a new link on the Orca server.'
    )
  }
  if (close.kind === 'refused' && close.code === MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE) {
    return failure(
      'host-unreachable',
      'The Orca server is not connected to Orca Relay. Confirm Relay sharing is still active on that server.'
    )
  }
  return failure(
    'host-unreachable',
    `Cannot reach the Orca server through Orca Relay (${describeRelayClose(close)}).`
  )
}

// Why: a generic "cannot reach" hides whether the network, the cell, or the handshake failed.
function describeRelayClose(close: RuntimeRelayLinkClose): string {
  switch (close.kind) {
    case 'refused':
      return `Relay code ${close.code}`
    case 'closed':
      return close.reason ? `${close.code}: ${close.reason}` : `connection closed ${close.code}`
    case 'protocol':
      return close.message
    case 'identity':
    case 'moved':
    case 'unauthorized':
      return close.kind
  }
}

function failure(kind: RemotePairingFailure['kind'], message: string): RemotePairingFailure {
  return { ok: false, kind, message }
}
