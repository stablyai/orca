import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { ManagedRuntime } from '../../node-runtime/managed-runtime-release'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'

export type AcpStructuredLocationSpec = {
  managedRuntime?: Pick<ManagedRuntime, 'pin'>
  hostBackend?: object
}

export function supportsAcpStructuredLocation(
  spec: AcpStructuredLocationSpec,
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof?: () => boolean
): boolean {
  return (
    supportsSupervisedProviderChildLocation(location, hasWindowsProcessStartTimeProof) &&
    // Without a release Orca can install here, only the host's own program can serve the chat.
    (!spec.managedRuntime || spec.managedRuntime.pin() !== null || spec.hostBackend !== undefined)
  )
}
