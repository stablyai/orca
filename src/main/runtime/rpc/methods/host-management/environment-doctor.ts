import { ENVIRONMENT_DOCTOR_METHOD } from '../../../../../shared/environment-doctor-runtime'
import { EnvironmentDoctorParams } from '../../../../../shared/rpc-contract/host-management/environment-doctor-params'
import { runEnvironmentDoctor } from '../../../../environment-doctor/environment-doctor'
import { createHostEnvironmentDoctorDeps } from '../../../../environment-doctor/environment-doctor-host'
import { defineMethod } from '../../core'

export const ENVIRONMENT_DOCTOR_METHODS = [
  // A desktop creating a workspace on a VM asks the VM's own server, so the checks see its tools.
  defineMethod({
    name: ENVIRONMENT_DOCTOR_METHOD,
    permission: 'workspace',
    params: EnvironmentDoctorParams,
    handler: async ({ path }) =>
      runEnvironmentDoctor(
        { worktreePath: path },
        createHostEnvironmentDoctorDeps({ refreshShellPath: true })
      )
  })
]
