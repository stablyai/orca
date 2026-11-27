import { ENVIRONMENT_DOCTOR_METHOD } from '../../../../../shared/workspace-setup/environment-doctor/environment-doctor-runtime'
import { EnvironmentDoctorParams } from '../../../../../shared/rpc-contract/host-management/environment-doctor-params'
import { runEnvironmentDoctor } from '../../../../environment-doctor/environment-doctor'
import {
  createHostEnvironmentDoctorDeps,
  runHostDoctorCommand
} from '../../../../environment-doctor/environment-doctor-host'
import { hydrateShellPathForAgentDetection } from '../../../../ipc/command-path/agent-detection-shell-path'
import { defineMethod } from '../../core'
import { homedir } from 'node:os'
import { checkDoubaoSignIn } from '../../../../environment-doctor/doubao-sign-in-check'

export const ENVIRONMENT_DOCTOR_METHODS = [
  defineMethod({
    name: 'preflight.checkDoubaoSignIn',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => {
      await hydrateShellPathForAgentDetection()
      const status = await checkDoubaoSignIn(
        {
          run: runHostDoctorCommand,
          platform: process.platform,
          agentSettings: runtime.requireStore().getSettings()
        },
        homedir()
      )
      return { status }
    }
  }),
  // A desktop creating a workspace on a VM asks the VM's own server, so the checks see its tools.
  defineMethod({
    name: ENVIRONMENT_DOCTOR_METHOD,
    permission: 'workspace',
    params: EnvironmentDoctorParams,
    handler: async ({ path }, { runtime }) =>
      runEnvironmentDoctor(
        { worktreePath: path },
        createHostEnvironmentDoctorDeps({
          refreshShellPath: true,
          agentSettings: runtime.requireStore().getSettings()
        })
      )
  })
]
