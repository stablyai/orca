import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { OrcadManagedStopCancellationResultSchema } from '../../shared/orcad-managed-stop-cancellation'
import { sameOrcadManagedStopInstance } from '../../shared/orcad-managed-stop-instance'
import { OrcadDecommissionResultSchema } from '../../shared/orcad-decommission'
import {
  OrcadManagedDecommissionParamsSchema,
  OrcadManagedDecommissionResultSchema,
  OrcadManagedStopIdentitySchema
} from '../../shared/orcad-managed-decommission'
import {
  sameOrcadManagedStopAuthority,
  type OrcadManagedStopAuthority
} from '../../shared/orcad-managed-stop-authority'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'

export async function readRemoteOrcadManagedStopIdentity(
  environment: KnownRuntimeEnvironment,
  expectedVersion: string,
  timeoutMs = 15_000
) {
  try {
    const runtimeId = requirePinnedRuntimeId(environment)
    const response = await sendRemoteRuntimeRequest<unknown>(
      getPreferredPairingOffer(environment),
      'orcad.managedStopIdentity',
      null,
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (!response.ok) {
      return unverifiableResult(response.error.message)
    }
    const result = OrcadManagedStopIdentitySchema.parse(response.result)
    if (result.identity.runtimeId !== runtimeId || result.version !== expectedVersion) {
      return unverifiableResult(
        'The managed-stop identity does not match the pinned runtime/version.'
      )
    }
    return { outcome: 'verified' as const, ...result }
  } catch (error) {
    return unverifiableResult(error instanceof Error ? error.message : String(error))
  }
}

export async function requestRemoteOrcadManagedDecommission(
  environment: KnownRuntimeEnvironment,
  expectedVersion: string,
  authority: OrcadManagedStopAuthority,
  timeoutMs = 15_000
) {
  try {
    const runtimeId = requirePinnedRuntimeId(environment)
    const request = OrcadManagedDecommissionParamsSchema.parse({
      version: expectedVersion,
      authority
    })
    if (request.authority.runtimeId !== runtimeId) {
      return unverifiableResult('The stop authority does not match the pinned runtime.')
    }
    const requestedAuthority = Object.freeze({ ...request.authority })
    const response = await sendRemoteRuntimeRequest<unknown>(
      getPreferredPairingOffer(environment),
      'orcad.decommissionManagedIfIdle',
      { version: request.version, authority: requestedAuthority },
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (!response.ok) {
      return unverifiableResult(response.error.message)
    }
    const result = OrcadManagedDecommissionResultSchema.parse(response.result)
    if (
      result.outcome === 'accepted' &&
      (result.transactionId !== requestedAuthority.transactionId ||
        !sameOrcadManagedStopAuthority(result.authority, requestedAuthority))
    ) {
      return unverifiableResult('The host acknowledged a different managed-stop authority.')
    }
    return result
  } catch (error) {
    return unverifiableResult(error instanceof Error ? error.message : String(error))
  }
}

function requirePinnedRuntimeId(environment: KnownRuntimeEnvironment): string {
  if (!environment.runtimeId?.trim()) {
    throw new Error('Managed stop requires a pinned runtime identity.')
  }
  return environment.runtimeId
}

export async function requestRemoteOrcadManagedStopCancellation(
  environment: KnownRuntimeEnvironment,
  original: OrcadManagedStopRequest,
  timeoutMs = 15_000
) {
  const refuse = (reason: string) => ({
    outcome: 'refused' as const,
    verdict: 'unverifiable' as const,
    code: 'orcad_cancellation_unverifiable',
    reason
  })
  try {
    const request = OrcadManagedStopRequestSchema.parse(original)
    const runtimeId = requirePinnedRuntimeId(environment)
    const pairing = getPreferredPairingOffer(environment)
    if (request.authority.runtimeId !== runtimeId) {
      return refuse('Cancellation authority does not match the pinned runtime.')
    }
    const identity = await readRemoteOrcadManagedStopIdentity(
      environment,
      request.version,
      timeoutMs
    )
    if (
      identity.outcome !== 'verified' ||
      identity.cancelPreparedStop !== 1 ||
      !identity.instance ||
      !sameOrcadManagedStopInstance(identity.instance, request.instance) ||
      !sameOrcadManagedStopAuthority(request.authority, {
        ...identity.identity,
        transactionId: request.authority.transactionId
      }) ||
      requirePinnedRuntimeId(environment) !== runtimeId
    ) {
      return refuse(
        'The original host instance does not advertise verified prepared-stop cancellation.'
      )
    }
    const response = await sendRemoteRuntimeRequest<unknown>(
      pairing,
      'orcad.cancelPreparedStop',
      request,
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (!response.ok) {
      return refuse(response.error.message)
    }
    const result = OrcadManagedStopCancellationResultSchema.parse(response.result)
    if (
      result.outcome === 'canceled' &&
      (result.version !== request.version ||
        !sameOrcadManagedStopAuthority(result.authority, request.authority) ||
        !sameOrcadManagedStopInstance(result.instance, request.instance))
    ) {
      return refuse('The host acknowledged cancellation of a different stop request.')
    }
    return result
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
}

export async function requestRemoteOrcadDecommission(
  environment: KnownRuntimeEnvironment,
  expectedVersion: string,
  transactionId?: string,
  timeoutMs = 15_000
) {
  try {
    const response = await sendRemoteRuntimeRequest<unknown>(
      getPreferredPairingOffer(environment),
      'orcad.decommissionIfIdle',
      { version: expectedVersion, ...(transactionId ? { transactionId } : {}) },
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (!response.ok) {
      return unverifiableResult(response.error.message)
    }
    return OrcadDecommissionResultSchema.parse(response.result)
  } catch (error) {
    return unverifiableResult(error instanceof Error ? error.message : String(error))
  }
}

function unverifiableResult(detail: string) {
  return {
    outcome: 'refused' as const,
    verdict: 'unverifiable' as const,
    code: 'orcad_decommission_unverifiable',
    reason: `The host could not atomically fence terminal creation and prove the daemon idle. ${detail}`
  }
}
