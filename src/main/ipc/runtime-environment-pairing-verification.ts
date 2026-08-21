import {
  addEnvironmentFromPairingCode,
  RuntimeEnvironmentStoreError
} from '../../shared/runtime-environment-store'
import { parseHostAccessLink } from '../../shared/remote-pairing-address'
import {
  verifyRemotePairingRuntimeStatus,
  type VerifyAndAddRuntimeEnvironmentResult
} from '../../shared/remote-pairing-verification'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-types'

type VerifyAndAddRuntimeEnvironmentArgs = {
  name: string
  pairingCode: string
  allowLoopback?: boolean
}

export async function verifyAndAddRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: VerifyAndAddRuntimeEnvironmentArgs
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const parsed = parseHostAccessLink(args.pairingCode)
  if (!parsed.ok) {
    return { ok: false, kind: 'access-link-invalid', message: parsed.message }
  }
  if (parsed.value.endpointKind === 'loopback' && !args.allowLoopback) {
    return {
      ok: false,
      kind: 'host-unreachable',
      message: 'This access link points back to this device.'
    }
  }

  let runtimeStatus: RuntimeStatus
  try {
    const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
      parsed.value.pairing,
      'status.get',
      undefined,
      15_000
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
    runtimeStatus = statusVerification.runtimeStatus
  } catch (error) {
    return classifyPairingVerificationError(error, parsed.value.displayEndpoint)
  }

  const usesSshTunnel = parsed.value.endpointKind === 'loopback' && args.allowLoopback === true
  let environment: ReturnType<typeof addEnvironmentFromPairingCode>
  try {
    environment = addEnvironmentFromPairingCode(userDataPath, {
      ...args,
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
    environment: redactRuntimeEnvironment(environment),
    runtimeStatus
  }
}

function classifyPairingVerificationError(
  error: unknown,
  endpoint: string
): VerifyAndAddRuntimeEnvironmentResult {
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

function invalidAccessLinkResult(): VerifyAndAddRuntimeEnvironmentResult {
  return {
    ok: false,
    kind: 'access-link-invalid',
    message: 'This access link contains invalid connection details.'
  }
}

function unreachableHostResult(endpoint: string): VerifyAndAddRuntimeEnvironmentResult {
  return {
    ok: false,
    kind: 'host-unreachable',
    message: `Cannot reach Orca at ${endpoint}. Confirm the other host is running and reachable.`
  }
}
