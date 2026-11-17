import { defineMethod } from '../../core'
import {
  ORCAD_WORK_VERDICT_METHOD,
  OrcadWorkVerdictParamsSchema
} from '../../../../../shared/hosted-sandbox/hosted-session-events'
import { readOrcadWorkVerdict } from '../../../../orcad/orcad-work-verdict'

export const ORCAD_WORK_VERDICT_METHODS = [
  defineMethod({
    name: ORCAD_WORK_VERDICT_METHOD,
    permission: 'host-admin',
    params: OrcadWorkVerdictParamsSchema,
    handler: async (_params, { runtime }) =>
      readOrcadWorkVerdict(runtime.terminalRunFacts.readLatestInputAt())
  })
]
