import { BrowserWindow } from 'electron'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { OrcadManagedPairingRepairFailedError } from '../../managed-server/lifecycle/orcad-managed-pairing-repair-failure'
import { recoverRefusedPairing } from './runtime-environment-pairing-refusal-registry'
import { recordRuntimeEnvironmentUsage } from './runtime-environment-usage-record'
import { RuntimeHostStatusOwner } from '../../../shared/runtime-host-status-owner'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  RUNTIME_HOST_STATUS_CHANNEL,
  runtimeHostStatusError,
  runtimeHostStatusFailure,
  type RuntimeHostStatusResponse
} from '../../../shared/runtime-host-status'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  getAcceptedRuntimeEnvironmentCapabilityOutcome,
  getRuntimeEnvironmentCapabilityIncarnation,
  captureRuntimeEnvironmentCapabilityEvidence
} from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'

const statusListeners = new Set<() => void>()

export function onRuntimeEnvironmentStatusPublished(listener: () => void): () => void {
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
    return error instanceof OrcadManagedPairingRepairFailedError
      ? runtimeHostStatusFailure('unauthorized', error.message)
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
  return new RuntimeHostStatusOwner({
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    request: async (signal) => {
      const incarnation = getRuntimeEnvironmentCapabilityIncarnation(environment.id)
      const isCurrent = (): boolean =>
        getRuntimeEnvironmentCapabilityIncarnation(environment.id) === incarnation
      if (environment.connectionDependency === 'ssh-tunnel') {
        try {
          await resolveManagedRuntimeEnvironment(userDataPath, environment.id)
        } catch (error) {
          if (error instanceof OrcadManagedPairingRepairFailedError) {
            return runtimeHostStatusFailure('unauthorized', error.message)
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
          : sendRemoteRuntimeRequest<RuntimeStatus>(
              connection,
              'status.get',
              undefined,
              15_000,
              undefined,
              signal,
              ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
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
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) {
          continue
        }
        try {
          window.webContents.send(RUNTIME_HOST_STATUS_CHANNEL, snapshot)
        } catch {
          /* A renderer can close during publication. */
        }
      }
      for (const listener of statusListeners) {
        listener()
      }
    }
  })
}
