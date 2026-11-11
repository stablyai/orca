import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  normalizeEndpointAuthHeaders,
  endpointAuthOrigin,
  type EndpointAuthHeaders
} from '../../../shared/network/endpoint-auth-headers'
import type { RuntimeEdgeAuthHeader } from '../../../shared/runtime-edge-auth-types'
import {
  readRuntimeEdgeAuth,
  writeRuntimeEdgeAuth
} from '../../credentials/runtime-edge-auth-store'
import { remoteRuntimeConnectOptions } from '../../../shared/remote-runtime/remote-runtime-connect-bound'
import {
  addOrUpdateEnvironmentFromPairingCode,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import {
  parseHostAccessLink,
  type ParsedHostAccessLink
} from '../../../shared/remote-runtime/pairing/remote-pairing-address'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure,
  type VerifyAndAddRuntimeEnvironmentResult
} from '../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { exchangeRemotePairingTicket } from '../../../shared/remote-runtime/pairing/remote-pairing-ticket-exchange'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairingOffer,
  isEphemeralVmRuntimeEnvironment,
  redactRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import {
  remoteServerPairingFailureText,
  type RemoteServerPairingFailureCode
} from '../../../shared/remote-runtime/pairing/remote-server-pairing-failure-copy'

type VerifyAndAddRuntimeEnvironmentArgs = {
  name: string
  pairingCode: string
  allowLoopback?: boolean
  edgeAuthHeaders?: RuntimeEdgeAuthHeader[]
}

type VerifiedPairingCode = {
  ok: true
  link: ParsedHostAccessLink
  runtimeStatus: RuntimeStatus
  connection: ReturnType<typeof pairedRuntimeConnectionFromOffer>
}

/** Proves a pairing link reaches a compatible host that accepts it, without saving anything. */
async function verifyPairingCode(
  pairingCode: string,
  allowLoopback: boolean | undefined,
  headers: EndpointAuthHeaders = {},
  savedAuth?: ReturnType<typeof readRuntimeEdgeAuth>
): Promise<VerifiedPairingCode | RemotePairingFailure> {
  const parsed = parseHostAccessLink(pairingCode)
  if (!parsed.ok) {
    return { ok: false, kind: 'access-link-invalid', message: parsed.message }
  }
  if (parsed.value.endpointKind === 'loopback' && !allowLoopback) {
    return {
      ok: false,
      kind: 'host-unreachable',
      message: 'This access link points back to this device.'
    }
  }
  try {
    const connection = pairedRuntimeConnectionFromOffer(parsed.value.pairing)
    const origin = endpointAuthOrigin(connection.endpoint)
    const edgeAuth =
      savedAuth ??
      (Object.keys(headers).length > 0
        ? { origin: origin ?? '', hostPublicKeyB64: connection.hostPublicKeyB64, headers }
        : undefined)
    const authenticated = edgeAuth ? { ...connection, edgeAuth } : connection
    remoteRuntimeConnectOptions(undefined, undefined, authenticated)
    const response = await sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
      authenticated,
      'status.get',
      undefined,
      15_000,
      undefined,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      undefined,
      undefined
    )
    if (!response.ok) {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: response.error.message
      }
    }
    const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
    if (!statusVerification.ok) {
      return statusVerification
    }
    return {
      ok: true,
      link: parsed.value,
      connection: authenticated,
      runtimeStatus: statusVerification.runtimeStatus
    }
  } catch (error) {
    return classifyPairingVerificationError(error, parsed.value.displayEndpoint)
  }
}

export async function verifyAndAddRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: VerifyAndAddRuntimeEnvironmentArgs
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const normalized = normalizeEndpointAuthHeaders(args.edgeAuthHeaders ?? [])
  if (!normalized.ok) {
    return {
      ok: false,
      kind: 'access-link-invalid',
      message: 'Enter valid edge authentication headers.'
    }
  }
  const verified = await verifyPairingCode(args.pairingCode, args.allowLoopback, normalized.headers)
  if (!verified.ok) {
    return verified
  }
  const { link, runtimeStatus } = verified
  const usesSshTunnel = link.endpointKind === 'loopback' && args.allowLoopback === true
  // Save a token only this computer holds; the link stops working once it is used.
  const pairingCode = await exchangeRemotePairingTicket({
    pairingCode: args.pairingCode,
    offer: link.pairing,
    hostCapabilities: runtimeStatus.capabilities,
    edgeAuth: verified.connection.edgeAuth
  })
  let outcome: ReturnType<typeof addOrUpdateEnvironmentFromPairingCode>
  try {
    outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      ...args,
      pairingCode,
      // Only a verified key match permits updating an existing server identity.
      runtimeId: runtimeStatus.runtimeId,
      ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
    })
  } catch (error) {
    return pairingSaveFailure(error, 'hostSaveFailed')
  }
  if (Object.keys(normalized.headers).length > 0) {
    try {
      writeRuntimeEdgeAuth(userDataPath, outcome.environment, normalized.headers)
    } catch {
      return {
        ok: false,
        kind: 'environment-save-failed',
        savedEnvironmentId: outcome.environment.id,
        savedEnvironmentPairingRevision:
          outcome.environment.pairingRevision ?? outcome.environment.createdAt,
        message:
          'The server was paired, but its edge credentials could not be saved. Retry saving credentials or configure them from the server menu.'
      }
    }
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(outcome.environment),
    runtimeStatus,
    ...(outcome.updatedExisting ? { updatedExisting: true as const } : {})
  }
}

/** Replace pairing only after verifying the saved host key; invalid or foreign links leave it untouched. */
export async function verifyAndRepairRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: { selector: string; pairingCode: string }
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const existing = resolveEnvironment(userDataPath, args.selector)
  if (isEphemeralVmRuntimeEnvironment(existing)) {
    return pairingSaveFailure(null, 'repairCloudWorkspace')
  }
  // SSH tunnel pairings legitimately use loopback links.
  let savedEdgeAuth: ReturnType<typeof readRuntimeEdgeAuth> = null
  if (!existing.connectionDependency && !existing.orcadDeployment && !existing.sshAccess) {
    try {
      savedEdgeAuth = readRuntimeEdgeAuth(userDataPath, existing)
    } catch {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message:
          'Could not read edge authentication. Unlock protected storage or update the saved credentials.'
      }
    }
  }
  const verified = await verifyPairingCode(
    args.pairingCode,
    existing.connectionDependency === 'ssh-tunnel',
    {},
    savedEdgeAuth
  )
  if (!verified.ok) {
    return verified
  }
  // Host key persists across restarts; runtimeId does not.
  if (verified.link.pairing.publicKeyB64 !== getPreferredPairingOffer(existing).publicKeyB64) {
    return {
      ok: false,
      kind: 'different-server',
      message: 'This pairing link is for a different server.'
    }
  }
  const pairingCode = await exchangeRemotePairingTicket({
    pairingCode: args.pairingCode,
    offer: verified.link.pairing,
    hostCapabilities: verified.runtimeStatus.capabilities,
    edgeAuth: verified.connection.edgeAuth
  })
  let environment: ReturnType<typeof updateEnvironmentFromPairingCode>
  try {
    environment = updateEnvironmentFromPairingCode(userDataPath, existing.id, {
      pairingCode,
      // The verified same host may have restarted with a new runtimeId.
      runtimeId: verified.runtimeStatus.runtimeId
    })
  } catch (error) {
    return pairingSaveFailure(error, 'repairSaveFailed')
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(environment),
    runtimeStatus: verified.runtimeStatus
  }
}

/** A store refusal keeps its own message and code; anything else gets the generic save failure. */
function pairingSaveFailure(
  error: unknown,
  fallback: RemoteServerPairingFailureCode
): RemotePairingFailure {
  if (error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument') {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message: error.message,
      ...error.pairingFailure
    }
  }
  return {
    ok: false,
    kind: 'environment-save-failed',
    message: remoteServerPairingFailureText(fallback),
    errorCode: fallback
  }
}

function classifyPairingVerificationError(error: unknown, endpoint: string): RemotePairingFailure {
  if (error instanceof RemoteRuntimeClientError) {
    if (error.code === 'invalid_argument') {
      return invalidAccessLinkResult()
    }
    if (error.code === 'unauthorized' || error.pairingStage === 'access-grant') {
      return {
        ok: false,
        kind: 'access-link-invalid',
        message: 'This access link is no longer valid. Generate a new link on the other host.'
      }
    }
    if (error.pairingStage === 'host-identity') {
      return {
        ok: false,
        kind: 'host-identity-mismatch',
        message: `Orca reached ${endpoint}, but that host does not match this access link.`
      }
    }
    if (error.pairingStage === 'runtime') {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: `The connection to ${endpoint} was interrupted during verification.`
      }
    }
    if (error.pairingStage === 'connect') {
      return unreachableHostResult(endpoint)
    }
  }
  if (error instanceof Error) {
    return error.message.startsWith('Invalid public key')
      ? invalidAccessLinkResult()
      : { ok: false, kind: 'connection-interrupted', message: error.message }
  }
  return unreachableHostResult(endpoint)
}

function invalidAccessLinkResult(): RemotePairingFailure {
  return {
    ok: false,
    kind: 'access-link-invalid',
    message: 'This access link contains invalid connection details.'
  }
}

function unreachableHostResult(endpoint: string): RemotePairingFailure {
  return {
    ok: false,
    kind: 'host-unreachable',
    message: `Cannot reach Orca at ${endpoint}. Confirm the other host is running and reachable.`
  }
}
