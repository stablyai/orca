import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { familyGoldens } from '../derived-goldens'
import { readGolden } from '../golden-recording'
import { pilotMountAdapters } from '../pilot-mount-adapters'
import { runRecordingMutant } from '../run-recording'
import { readScenarios } from '../scenario-input'
import { vitestRecordingScheduler } from '../vitest-recording-scheduler'
import { operationMutation, type Mutation } from './operation-mutations'
import type { Recording } from '../recording-scenario'

const root = resolve(import.meta.dirname, '../../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const goldens = process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

// Compare the whole variant: malformed-container mutants may differ only at settlement and recover to identical final state.
// Pin both a killing and a blind partition; row-shape requirements remain unit coverage because matrices vary envelopes only.
const MATRIX_MUTANTS: readonly {
  mutation: Mutation
  family: string
  site: string
  killedBy: string
  blindTo: string
}[] = [
  {
    mutation: 'linear-status-nullable',
    family: 'tasks.provider-load',
    site: 'linear.status#1',
    killedBy: 'result-null',
    blindTo: 'normal'
  }
]

function variantBaseline(golden: Recording, scenarioId: string): Recording {
  const prefix = `${scenarioId}:`
  const checkpoints = golden.checkpoints
    .filter((checkpoint) => checkpoint.id.startsWith(prefix))
    .map((checkpoint) => ({ ...checkpoint, id: checkpoint.id.slice(prefix.length) }))
  if (!checkpoints.length) {
    throw new Error(`No recorded checkpoints for ${scenarioId} in ${golden.scenario}`)
  }
  return { scenario: scenarioId, checkpoints }
}

async function verdict(
  entry: (typeof MATRIX_MUTANTS)[number],
  partition: string
): Promise<'killed' | 'survived'> {
  const derived = familyGoldens(input.scenarios).find(
    (golden) => golden.family === entry.family && golden.site === entry.site
  )
  if (!derived) {
    throw new Error(`No matrix golden for ${entry.family} at ${entry.site}`)
  }
  const scenario = derived.scenarios().find((candidate) => candidate.id.endsWith(`.${partition}`))
  if (!scenario) {
    throw new Error(`No ${partition} variant of ${derived.id}`)
  }
  const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
    device: scenario,
    mutation: operationMutation(entry.mutation)
  })
  const result = await runRecordingMutant(
    scenario,
    adapters[scenario.operation],
    vitestRecordingScheduler(),
    variantBaseline(readGolden(goldens, derived.id).recording, scenario.id)
  )
  assertMutationApplied()
  return result.verdict
}

describe('reply-matrix partitions hold the container requirements', () => {
  for (const entry of MATRIX_MUTANTS) {
    it(`${entry.family} ${entry.site}: ${entry.killedBy} kills ${entry.mutation}`, async () => {
      expect(await verdict(entry, entry.killedBy)).toBe('killed')
    }, 30_000)
    it(`${entry.family} ${entry.site}: ${entry.blindTo} cannot see ${entry.mutation}`, async () => {
      expect(await verdict(entry, entry.blindTo)).toBe('survived')
    }, 30_000)
  }
})
