import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'

export function supportsAcpStructuredLocation(
  spec: Pick<AcpLaunchSpec, 'managedRuntime' | 'hostBackend'>,
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof?: () => boolean
): boolean {
  return (
    supportsSupervisedProviderChildLocation(location, hasWindowsProcessStartTimeProof) &&
    // Without a release Orca can install here, only the host's own program can serve the chat.
    (!spec.managedRuntime || spec.managedRuntime.pin() !== null || spec.hostBackend !== undefined)
  )
}
