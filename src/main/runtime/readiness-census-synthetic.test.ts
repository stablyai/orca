// Part of the readiness census; readiness-census.test.ts documents it and how to regenerate.
import { describe, expect, it } from 'vitest'
import { checkCensusCases } from './readiness-census-baseline'
import { useCensusEnvironment } from './readiness-census-pane-probe'
import {
  CENSUS_AGENTS,
  runSyntheticCase,
  syntheticCases
} from './readiness-census-synthetic-matrix'

describe('readiness census: synthetic evidence matrix', () => {
  useCensusEnvironment()
  it.each(CENSUS_AGENTS)('%s', async (agent) => {
    const observations: Record<string, string> = {}
    for (const entry of syntheticCases(agent)) {
      Object.assign(observations, await runSyntheticCase(agent, entry))
    }
    const diff = checkCensusCases(
      `synthetic/${agent}`,
      `${agent}: title x first-party status on a painted screen; screen x foreground under the titles that leave the low lanes open; dialog order x title. Each read clocked and clockless.`,
      observations
    )
    expect(diff).toBe('')
  })
})
