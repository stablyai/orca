import { defineMethod } from '../core'
import {
  ORCAD_TERMINAL_CENSUS_METHOD,
  OrcadTerminalCensusParamsSchema
} from '../../../../shared/orcad-terminal-census'

export const ORCAD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: ORCAD_TERMINAL_CENSUS_METHOD,
    params: OrcadTerminalCensusParamsSchema,
    handler: async (params) => {
      // Why lazy: the census reaches the daemon modules, whose xterm polyfill defines a global
      // `window`; importing them statically would load it into every process with the dispatcher.
      const { collectOrcadTerminalCensus } = await import('../../../orcad/orcad-terminal-census')
      return collectOrcadTerminalCensus(params.activatedAt)
    }
  })
]
