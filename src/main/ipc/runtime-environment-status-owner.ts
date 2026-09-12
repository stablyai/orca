import { BrowserWindow } from 'electron'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
} from '../../shared/protocol-version'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { markEnvironmentUsed } from '../../shared/runtime-environment-store'
import { RuntimeHostStatusOwner } from '../../shared/runtime-host-status-owner'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  RUNTIME_HOST_STATUS_CHANNEL,
  type RuntimeHostStatusResponse
} from '../../shared/runtime-host-status'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  getAcceptedRuntimeEnvironmentCapabilityOutcome,
  getRuntimeEnvironmentCapabilityIncarnation,
  captureRuntimeEnvironmentCapabilityEvidence
} from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'

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
  const pairing = getPreferredPairingOffer(environment)
  let evidence = captureRuntimeEnvironmentCapabilityEvidence(environment.id, pairing)
  return new RuntimeHostStatusOwner({
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    request: async (signal) => {
      const incarnation = getRuntimeEnvironmentCapabilityIncarnation(environment.id)
      const isCurrent = (): boolean =>
        getRuntimeEnvironmentCapabilityIncarnation(environment.id) === incarnation
      if (environment.connectionDependency === 'ssh-tunnel') {
        await resolveManagedRuntimeEnvironment(userDataPath, environment.id)
        if (!isCurrent()) {
          return runtimeEnvironmentChangedFailure(environment, 'status.get')
        }
        signal.throwIfAborted()
      }
      evidence = captureRuntimeEnvironmentCapabilityEvidence(environment.id, pairing)
      const response = await (transport.isReady() &&
      getAcceptedRuntimeEnvironmentCapabilityOutcome(environment.id, pairing, null)?.kind ===
        'supported'
        ? transport.request(signal)
        : sendRemoteRuntimeRequest<RuntimeStatus>(
            pairing,
            'status.get',
            undefined,
            15_000,
            undefined,
            signal,
            ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
          ))
      return isCurrent() ? response : runtimeEnvironmentChangedFailure(environment, 'status.get')
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
        markEnvironmentUsed(userDataPath, environment.id, {
          runtimeId: response._meta.runtimeId,
          pairedDeviceId: response.result.pairedDeviceId
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
    }
  })
}
