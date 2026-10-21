import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { AcpLaunchSpec } from './acp-launch-specs'

/** The execution host can supervise this ACP child and has its pinned build when one is required. */
export function supportsAcpStructuredLocation(
  spec: AcpLaunchSpec,
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof?: () => boolean
): boolean {
  return (
    supportsSupervisedProviderChildLocation(location, hasWindowsProcessStartTimeProof) &&
    (!spec.managedRuntime || spec.managedRuntime.pin() !== null)
  )
}
