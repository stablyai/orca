import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getPreferredPairedRuntimeConnection,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { getRuntimeEnvironmentCapabilityIncarnation } from './runtime-environment-capability-evidence'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'
import { attachRemoteControlDiagnostics } from './runtime-environment-status-diagnostics'
import { withTailscaleHintForResponse } from './runtime-environment-tailscale-response'

export async function getRuntimeEnvironmentStatus(
  userDataPath: string,
  selector: string,
  timeoutMs?: number,
  options?: { observeOnly?: true; signal?: AbortSignal; reconnect?: true },
  /** False for a caller pinned to this pairing revision, which a re-pair must fail instead. */
  followRepair = true
): Promise<RuntimeRpcResponse<RuntimeStatus>> {
  const environment = resolveEnvironment(userDataPath, selector)
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    return {
      id: 'status.get',
      ok: false,
      error: {
        code: 'runtime_manually_disconnected',
        message: 'Runtime environment is manually disconnected.'
      }
    }
  }
  const incarnation = getRuntimeEnvironmentCapabilityIncarnation(environment.id)
  const response = await getRuntimeEnvironmentStatusOwner(userDataPath, environment.id).refresh({
    timeoutMs,
    ...options
  })
  // A retired request must not publish old status or borrow its replacement's diagnostics.
  if (getRuntimeEnvironmentCapabilityIncarnation(environment.id) !== incarnation) {
    // Follow one repair started by this probe; the successor owner verifies the new pairing.
    return followRepair && repairedSameServer(userDataPath, environment)
      ? getRuntimeEnvironmentStatus(userDataPath, environment.id, timeoutMs, options, false)
      : runtimeEnvironmentChangedFailure(environment, 'status.get')
  }
  return attachRemoteControlDiagnostics(
    withTailscaleHintForResponse(
      response,
      getPreferredPairedRuntimeConnection(environment).endpoint,
      environment
    ),
    environment.id
  )
}

/** Follow only SSH-managed repairs under the same pinned host key; other replacements remain changed. */
function repairedSameServer(userDataPath: string, before: KnownRuntimeEnvironment): boolean {
  try {
    const after = resolveEnvironment(userDataPath, before.id)
    return (
      (after.pairingRevision ?? after.createdAt) !== (before.pairingRevision ?? before.createdAt) &&
      getOrcadSshDeployment(before) !== undefined &&
      getOrcadSshDeployment(after) !== undefined &&
      getPreferredPairingOffer(after).publicKeyB64 === getPreferredPairingOffer(before).publicKeyB64
    )
  } catch {
    return false
  }
}
