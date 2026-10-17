import { defineMethod } from '../core'
import type { z } from 'zod'
import {
  ORCAD_TERMINAL_CENSUS_METHOD,
  OrcadTerminalCensusParamsSchema,
  type OrcadTerminalCensus
} from '../../../../shared/orcad-terminal-census'
import {
  closeTerminalAdmission,
  waitForTerminalSpawnsToSettle
} from '../../terminal-admission-fence'

const SPAWN_SETTLE_MS = 10_000
const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

type OrcadTerminalCensusParams = z.infer<typeof OrcadTerminalCensusParamsSchema>

export const ORCAD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: ORCAD_TERMINAL_CENSUS_METHOD,
    permission: 'host-admin',
    params: OrcadTerminalCensusParamsSchema,
    handler: async (params, { runtime }) => {
      // Before counting: a terminal admitted after the count would die with the stop unseen.
      if (params.closeAdmissionForMs === undefined) {
        return countTerminals(params, runtime)
      }
      const admissionClosedUntil = closeTerminalAdmission(params.closeAdmissionForMs)
      // A spawn admitted before the fence may still be starting; count only once it has.
      if (admissionClosedUntil > 0 && !(await waitForTerminalSpawnsToSettle(SPAWN_SETTLE_MS))) {
        return { ...UNVERIFIABLE, admissionClosedUntil }
      }
      return { ...(await countTerminals(params, runtime)), admissionClosedUntil }
    }
  })
]

async function countTerminals(
  params: OrcadTerminalCensusParams,
  runtime: { releaseFinishedAutomationRunTerminals(): Promise<number> }
): Promise<OrcadTerminalCensus> {
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
