import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { sshTargetStarts } from '../../ssh/ssh-target-start-window'
import type { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'
import { OrcadTunnelSupersededError } from './orcad-managed-tunnel-active'

/** A machine mid-wake is waited for, and one just started is redialed while its sshd comes up. */
export function ensureTunnelAfterHostStart(
  tunnels: Pick<OrcadManagedTunnelManager, 'ensure'>,
  environment: KnownRuntimeEnvironment,
  resolveCurrent?: () => KnownRuntimeEnvironment | null,
  starts = sshTargetStarts
): Promise<void> {
  return starts.dial(
    getRuntimeSshAccess(environment)?.sshTargetId,
    () => tunnels.ensure(environment, resolveCurrent),
    // A close or disconnect superseded the tunnel; building it again would undo that.
    (error) => error instanceof OrcadTunnelSupersededError
  )
}
