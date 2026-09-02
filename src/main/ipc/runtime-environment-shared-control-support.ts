import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
} from '../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { markEnvironmentUsed } from '../../shared/runtime-environment-store'
import type {
  getPreferredPairingOffer,
  KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  getAcceptedRuntimeEnvironmentCapabilityOutcome,
  isRuntimeEnvironmentCapabilityOutcomeCurrent,
  runtimeEnvironmentCapabilityOutcome,
  resetRuntimeEnvironmentCapabilityEvidence,
  type RuntimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'
import { pauseRemoteRuntimeSharedControlRetry } from './runtime-environment-request-connections'

const sharedControlSupport = new Map<
  string,
  { cacheKey: string; check: Promise<RuntimeEnvironmentCapabilityOutcome> }
>()

export function resetSharedControlSupport(): void {
  sharedControlSupport.clear()
  resetRuntimeEnvironmentCapabilityEvidence()
}

export function clearSharedControlSupport(environmentId: string): void {
  sharedControlSupport.delete(environmentId)
}

export async function supportsSharedControl(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  pairing: ReturnType<typeof getPreferredPairingOffer>,
  timeoutMs: number
): Promise<RuntimeEnvironmentCapabilityOutcome> {
  const accepted = getAcceptedRuntimeEnvironmentCapabilityOutcome(
    environment.id,
    pairing,
    environment.runtimeId
  )
  if (accepted) {
    return accepted
  }
  const cacheKey = getSharedControlSupportCacheKey(environment, pairing)
  const cached = sharedControlSupport.get(environment.id)
  if (cached?.cacheKey === cacheKey) {
    const outcome = await cached.check
    if (isRuntimeEnvironmentCapabilityOutcomeCurrent(outcome)) {
      return outcome
    }
    if (sharedControlSupport.get(environment.id)?.check === cached.check) {
      sharedControlSupport.delete(environment.id)
    }
    return { kind: 'stale_incarnation' }
  }
  let resolvedCacheKey = cacheKey
  const evidence = captureRuntimeEnvironmentCapabilityEvidence(environment.id, pairing)
  const check = (async () => {
    const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
      pairing,
      'status.get',
      undefined,
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (response.ok === true) {
      const verdict = response.result.capabilities?.includes(
        REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
      )
        ? 'capable'
        : 'absent'
      const acceptedEvidence = applyRuntimeEnvironmentCapabilityVerdict({
        evidence,
        verdict,
        runtimeId: response._meta.runtimeId,
        onAbsent: () => pauseRemoteRuntimeSharedControlRetry(environment.id)
      })
      if (!acceptedEvidence) {
        return { kind: 'stale_incarnation' } as const
      }
      markEnvironmentUsed(userDataPath, environment.id, { runtimeId: response._meta.runtimeId })
      resolvedCacheKey = getSharedControlSupportCacheKey(
        environment,
        pairing,
        response._meta.runtimeId
      )
      return runtimeEnvironmentCapabilityOutcome(evidence, verdict, response._meta.runtimeId)
    }
    return runtimeEnvironmentCapabilityOutcome(
      evidence,
      'absent',
      environment.runtimeId ?? 'unknown-runtime'
    )
  })()
  // Why: support belongs to the saved pairing/runtime identity, not its mutable display name.
  sharedControlSupport.set(environment.id, { cacheKey, check })
  try {
    const outcome = await check
    const cachedAfterCheck = sharedControlSupport.get(environment.id)
    if (cachedAfterCheck?.check === check && cachedAfterCheck.cacheKey !== resolvedCacheKey) {
      sharedControlSupport.set(environment.id, { cacheKey: resolvedCacheKey, check })
    }
    return outcome
  } catch (error) {
    if (sharedControlSupport.get(environment.id)?.check === check) {
      sharedControlSupport.delete(environment.id)
    }
    throw error
  }
}

function getSharedControlSupportCacheKey(
  environment: KnownRuntimeEnvironment,
  pairing: ReturnType<typeof getPreferredPairingOffer>,
  runtimeId = environment.runtimeId
): string {
  return [
    runtimeId ?? 'unknown-runtime',
    pairing.endpoint,
    pairing.deviceToken,
    pairing.publicKeyB64
  ].join('\0')
}
