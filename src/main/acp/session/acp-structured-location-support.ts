import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'

export function supportsAcpStructuredLocation(
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof?: () => boolean
): boolean {
  return supportsSupervisedProviderChildLocation(location, hasWindowsProcessStartTimeProof)
}
