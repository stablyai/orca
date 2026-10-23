import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import {
  addOrUpdateEnvironmentFromPairingCode,
  resolveEnvironment,
  RuntimeEnvironmentStoreError,
  updateEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import {
  parseHostAccessLink,
  type ParsedHostAccessLink
} from '../../../shared/remote-pairing-address'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure,
  type VerifyAndAddRuntimeEnvironmentResult
} from '../../../shared/remote-pairing-verification'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairingOffer,
  isEphemeralVmRuntimeEnvironment,
  redactRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'

type VerifyAndAddRuntimeEnvironmentArgs = {
  name: string
  pairingCode: string
  allowLoopback?: boolean
}

type VerifiedPairingCode = {
  ok: true
  link: ParsedHostAccessLink
  runtimeStatus: RuntimeStatus
}

/** Proves a pairing link reaches a compatible host that accepts it, without saving anything. */
async function verifyPairingCode(
  pairingCode: string,
  allowLoopback: boolean | undefined
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
    const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
      pairedRuntimeConnectionFromOffer(parsed.value.pairing),
      'status.get',
      undefined,
      15_000,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
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
  const verified = await verifyPairingCode(args.pairingCode, args.allowLoopback)
  if (!verified.ok) {
    return verified
  }
  const { link, runtimeStatus } = verified
  const usesSshTunnel = link.endpointKind === 'loopback' && args.allowLoopback === true
  let outcome: ReturnType<typeof addOrUpdateEnvironmentFromPairingCode>
  try {
    outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      ...args,
      // Why: recorded only if the link is for a saved server, which the key match proves it is.
      runtimeId: runtimeStatus.runtimeId,
      ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
    })
  } catch (error) {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message:
        error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
          ? error.message
          : 'Orca verified the host but could not save it. Check local settings storage and try again.'
    }
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(outcome.environment),
    runtimeStatus,
    ...(outcome.updatedExisting ? { updatedExisting: true as const } : {})
  }
}

/**
 * Replaces a saved server's revoked pairing with a fresh link to the same server. Nothing is
 * written unless the link verifies and carries the saved server's key, so a bad or foreign link
 * leaves the working record untouched.
 */
export async function verifyAndRepairRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: { selector: string; pairingCode: string }
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const existing = resolveEnvironment(userDataPath, args.selector)
  if (isEphemeralVmRuntimeEnvironment(existing)) {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message: 'This server belongs to a cloud workspace, which pairs it again when it resumes.'
    }
  }
  // Why: a tunnel-backed server is legitimately re-paired with a loopback link.
  const verified = await verifyPairingCode(
    args.pairingCode,
    existing.connectionDependency === 'ssh-tunnel'
  )
  if (!verified.ok) {
    return verified
  }
  // Why the key, not runtimeId: runtimeId is minted per server process, so a restart changes it.
  if (verified.link.pairing.publicKeyB64 !== getPreferredPairingOffer(existing).publicKeyB64) {
    return {
      ok: false,
      kind: 'different-server',
      message: 'This pairing link is for a different server.'
    }
  }
  let environment: ReturnType<typeof updateEnvironmentFromPairingCode>
  try {
    environment = updateEnvironmentFromPairingCode(userDataPath, existing.id, {
      pairingCode: args.pairingCode,
      // Why: the key match proves the same server; a restarted one may report a new runtimeId.
      runtimeId: verified.runtimeStatus.runtimeId
    })
  } catch (error) {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message:
        error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
          ? error.message
          : 'Orca verified the server but could not save the new pairing. Check local settings storage and try again.'
    }
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(environment),
    runtimeStatus: verified.runtimeStatus
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
