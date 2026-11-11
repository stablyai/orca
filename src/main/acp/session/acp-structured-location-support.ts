import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'

/** Return true when `location` can supervise ACP child processes and `spec` has a runnable backend on this host. */
export function supportsAcpStructuredLocation(
  spec: AcpLaunchSpec,
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof?: () => boolean
): boolean {
  return (
    supportsSupervisedProviderChildLocation(location, hasWindowsProcessStartTimeProof) &&
    // Without a release Orca can install here, only the host's own program can serve the chat.
    (!spec.managedRuntime || spec.managedRuntime.pin() !== null || spec.hostBackend !== undefined)
  )
}
