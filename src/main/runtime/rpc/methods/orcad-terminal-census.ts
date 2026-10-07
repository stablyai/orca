import { defineMethod } from '../core'
import {
  ORCAD_TERMINAL_CENSUS_METHOD,
  OrcadTerminalCensusParamsSchema,
  type OrcadTerminalCensus
} from '../../../../shared/orcad-terminal-census'

export const ORCAD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: ORCAD_TERMINAL_CENSUS_METHOD,
    params: OrcadTerminalCensusParamsSchema,
    handler: async (params, { runtime }) => {
      // Why lazy: the census reaches the daemon modules, whose xterm polyfill defines a global
      // `window`; importing them statically would load it into every process with the dispatcher.
      const { collectOrcadTerminalCensus } = await import('../../../orcad/orcad-terminal-census')
      if (!params.releaseFinishedAutomationTerminals) {
        return collectOrcadTerminalCensus(params.activatedAt)
      }
      const before = await collectOrcadTerminalCensus(params.activatedAt)
      const released = await runtime.releaseFinishedAutomationRunTerminals()
      return settledCensus(
        () => collectOrcadTerminalCensus(params.activatedAt),
        before.liveSessions === null ? null : before.liveSessions - released
      )
    }
  })
]

/** Closed sessions leave the daemon a moment after the close; wait briefly for the count to drop. */
async function settledCensus(
  collect: () => Promise<OrcadTerminalCensus>,
  expectedAtMost: number | null
): Promise<OrcadTerminalCensus> {
  let census = await collect()
  for (let attempt = 0; attempt < 15 && expectedAtMost !== null; attempt += 1) {
    if (census.liveSessions === null || census.liveSessions <= expectedAtMost) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    census = await collect()
  }
  return census
}
