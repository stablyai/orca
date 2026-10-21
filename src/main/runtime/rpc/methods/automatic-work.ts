import { defineMethod } from '../core'
import { AUTOMATIC_WORK_RESUME_UNSUPPORTED } from '../../../../shared/host-spawn-admission'

// `automaticWork: null` means no gate to report or resume, unless `terminalHostPredatesResume`.
export const AUTOMATIC_WORK_METHODS = [
  defineMethod({
    name: 'runtime.automaticWork.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      automaticWork: await runtime.getAutomaticWorkStatus()
    })
  }),
  defineMethod({
    name: 'runtime.automaticWork.resume',
    permission: 'host-admin',
    params: null,
    handler: async (_params, { runtime }) => {
      const outcome = await runtime.resumeAutomaticWork()
      return outcome === AUTOMATIC_WORK_RESUME_UNSUPPORTED
        ? { automaticWork: null, terminalHostPredatesResume: true }
        : { automaticWork: outcome }
    }
  })
]
