import type { SshPortForwardAdmission } from './ssh-port-forward-admission'
import type { SshPortForwardRetirementCohort } from './ssh-port-forward-retirement-cohort'

export function assertPortForwardResourcesAbsent(
  targetId: string,
  admission: SshPortForwardAdmission,
  cohort: SshPortForwardRetirementCohort | undefined,
  hasPublished: () => boolean
): void {
  const assertUnpublished = () => {
    admission.assertAbsent(targetId)
    if (hasPublished()) {
      throw new Error('ssh_port_forward_target_still_retained')
    }
  }
  assertUnpublished()
  cohort?.assertAbsent()
  assertUnpublished()
}
