import { resolveRuntimeEnvironmentConnection } from '../../runtime/runtime-environment-edge-auth'
import { getRuntimeDesktopSurface } from '../../runtime/construction/runtime-desktop-surface'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { managedOrcadRefusalNeedingUserCode } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { recoverRefusedPairing } from './runtime-environment-pairing-refusal-registry'
import { recordRuntimeEnvironmentUsage } from '../../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import { RuntimeHostStatusOwner } from '../../../shared/remote-runtime/host-status/runtime-host-status-owner'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import {
  RUNTIME_HOST_STATUS_CHANNEL,
  type RuntimeHostStatusSnapshot,
  runtimeHostStatusError,
  runtimeHostStatusFailure,
  type RuntimeHostStatusResponse
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  getAcceptedRuntimeEnvironmentCapabilityOutcome,
  getRuntimeEnvironmentCapabilityIncarnation,
  captureRuntimeEnvironmentCapabilityEvidence
} from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { isRecipeVmEnvironmentAsleep } from '../../ephemeral-vm/recipe-vm-asleep'
import { noteRuntimeEnvironmentStatusContact } from './runtime-environment-contact-loss'
import {
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
} from '../../../shared/remote-runtime/recipe-vm-wake'

const statusListeners = new Set<(snapshot: RuntimeHostStatusSnapshot) => void>()

export function onRuntimeEnvironmentStatusPublished(
  listener: (snapshot: RuntimeHostStatusSnapshot) => void
): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

/** SSH-managed servers recover pairing automatically; failed repair keeps authentication blocked. */
async function answerRefusedPairing(
  environment: KnownRuntimeEnvironment,
  refused: RuntimeHostStatusResponse
): Promise<RuntimeHostStatusResponse> {
  const recovery = recoverRefusedPairing(environment.id)
  if (!recovery) {
    return refused
  }
  let outcome: 'built' | 'repaired'
  try {
    outcome = await recovery
  } catch (error) {
    const code = managedOrcadRefusalNeedingUserCode(error)
    return code && error instanceof Error
      ? runtimeHostStatusFailure(code, error.message)
      : runtimeHostStatusError(error)
  }
  // Rebuild re-proved the server, making refusal stale; only re-pairing retires this status owner.
  return runtimeEnvironmentChangedFailure(environment, 'status.get', outcome === 'repaired')
}

export function createRuntimeEnvironmentStatusOwner(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  transport: {
    isReady: () => boolean
    request: (signal: AbortSignal) => Promise<RuntimeHostStatusResponse>
    establish: () => void
    pause: () => void
  }
): RuntimeHostStatusOwner {
  const connection = getPreferredPairedRuntimeConnection(environment)
  let evidence = captureRuntimeEnvironmentCapabilityEvidence(environment.id, connection)
  const probe = async (signal: AbortSignal): Promise<RuntimeHostStatusResponse> => {
    const incarnation = getRuntimeEnvironmentCapabilityIncarnation(environment.id)
    const isCurrent = (): boolean =>
      getRuntimeEnvironmentCapabilityIncarnation(environment.id) === incarnation
    // A sleeping VM's health probe would be the dial that wakes it; answer without dialing.
    // (A tunnelled server is refused the same way by its preparation below.)
    if (isRecipeVmEnvironmentAsleep(userDataPath, environment.id)) {
      return runtimeHostStatusFailure(
        RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
        RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
      )
    }
    if (environment.connectionDependency === 'ssh-tunnel') {
      try {
        await resolveManagedRuntimeEnvironment(userDataPath, environment.id)
      } catch (error) {
        const code = managedOrcadRefusalNeedingUserCode(error)
        if (code && error instanceof Error) {
          return runtimeHostStatusFailure(code, error.message)
        }
        throw error
      }
      if (!isCurrent()) {
        return runtimeEnvironmentChangedFailure(environment, 'status.get')
      }
      signal.throwIfAborted()
    }
    evidence = captureRuntimeEnvironmentCapabilityEvidence(environment.id, connection)
    let response: RuntimeHostStatusResponse
    try {
      response = await (transport.isReady() &&
      getAcceptedRuntimeEnvironmentCapabilityOutcome(environment.id, connection, null)?.kind ===
        'supported'
        ? transport.request(signal)
        : sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
            resolveRuntimeEnvironmentConnection(userDataPath, environment),
            'status.get',
            undefined,
            15_000,
            undefined,
            undefined,
            signal,
            ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
            undefined,
            undefined
          ))
    } catch (error) {
      response = runtimeHostStatusError(error)
      if (response.ok || response.error.code !== 'unauthorized') {
        throw error
      }
    }
    if (!isCurrent()) {
      return runtimeEnvironmentChangedFailure(environment, 'status.get')
    }
    return !response.ok && response.error.code === 'unauthorized'
      ? answerRefusedPairing(environment, response)
      : response
  }
  return new RuntimeHostStatusOwner({
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    // Each probe's outcome is evidence for whether the server's host is still there (#34089).
    request: async (signal) => {
      try {
        const response = await probe(signal)
        noteRuntimeEnvironmentStatusContact(environment.id, response)
        return response
      } catch (error) {
        // A malformed reply still came from the server; the owner blocks on it.
        if (!signal.aborted && !(error instanceof TypeError || error instanceof SyntaxError)) {
          noteRuntimeEnvironmentStatusContact(environment.id, runtimeHostStatusError(error))
        }
        throw error
      }
    },
    verified: (response, active) => {
      const capable =
        response.result.capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) ?? false
      const accepted = applyRuntimeEnvironmentCapabilityVerdict({
        evidence,
        verdict: capable ? 'capable' : 'absent',
        runtimeId: response._meta.runtimeId
      })
      if (accepted && active && !isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        recordRuntimeEnvironmentUsage(userDataPath, environment.id, {
          runtimeId: response._meta.runtimeId,
          pairedDeviceId: response.result.pairedDeviceId,
          pairingDeviceToken: connection.credential.deviceToken
        })
        if (capable) {
          transport.establish()
        } else {
          transport.pause()
        }
      }
      return capable && active
    },
    publish: (snapshot) => {
      getRuntimeDesktopSurface().sendToRenderers?.(RUNTIME_HOST_STATUS_CHANNEL, snapshot)
      for (const listener of statusListeners) {
        listener(snapshot)
      }
    }
  })
}
