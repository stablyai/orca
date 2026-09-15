import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pilotGoldens } from '../derived-goldens'
import { readGolden } from '../golden-recording'
import { pilotMountAdapters } from '../pilot-mount-adapters'
import { runRecording, runRecordingMutant } from '../run-recording'
import { readScenarios } from '../scenario-input'
import { vitestRecordingScheduler } from '../vitest-recording-scheduler'
import { operationMutation, type Mutation } from './operation-mutations'
import type { Recording } from '../recording-scenario'
import type { RecordedValue } from '../recording-values'

const root = resolve(import.meta.dirname, '../../../../..')

const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)

const goldens = process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

// One mutant per adapter family, so every family's state projection is shown to be load-bearing.
const mutants: Record<string, Mutation> = {
  b1: 'race',
  b2: 'acceptance',
  b3: 'order',
  'settings-bot-overrides-fulfilled': 'bot-overrides-envelope',
  'settings-workspace-context-fulfilled': 'workspace-context-envelope',
  'settings-home-providers-fulfilled': 'home-providers-linear',
  'settings-repo-metadata-fulfilled': 'repo-metadata-platform',
  'settings-task-hydration-fulfilled': 'task-hydration-envelope',
  'settings-task-write': 'task-preferences-optimistic',
  'settings-workspace-submit-fulfilled': 'workspace-submit-envelope',
  'settings-task-workspace-fulfilled': 'task-workspace-envelope'
}

/**
 * The archived tree's visible state, pinned per seed: b1 serves the poisoned empty inventory, b2
 * accepts the null envelope and applies the label anyway, and b3 reports the issue error instead of
 * the comments error. An unrelated refactor of those files can no longer keep this green by merely
 * differing; the mutants remain the defect evidence and this run corroborates them.
 */
const referenceStates: Record<string, RecordedValue> = {
  b1: { files: [] },
  b2: {
    error: '',
    mutating: false,
    row: {
      content: {
        assignees: [],
        labels: [{ color: '808080', name: 'recorded' }],
        number: 1,
        repository: 'owner/repo'
      },
      id: 'item-1',
      itemType: 'ISSUE'
    }
  },
  b3: { error: 'issue refused', loading: false, payload: { $rpc: 'null' } }
}

function visibleState(recording: Recording): RecordedValue {
  return recording.checkpoints.at(-1)!.observation.state
}

// Pair pilots with their pinned mutant/reference up front so each loop below defines exactly one test.
const pilots = pilotGoldens(input.scenarios)

const mutantPilots = pilots.flatMap((pilot) => {
  const mutation = mutants[pilot.id]

  return mutation ? [{ ...pilot, mutation }] : []
})

const referencePilots = pilots.flatMap((pilot) => {
  const reference = referenceStates[pilot.id]

  return reference ? [{ ...pilot, reference }] : []
})

describe('RPC main recording mutants', () => {
  for (const { id, scenario, mutation } of mutantPilots) {
    it(`${id}: kills ${mutation}`, async () => {
      const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
        mutation: operationMutation(mutation)
      })

      const result = await runRecordingMutant(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler(),
        readGolden(goldens, id).recording,
        visibleState
      )

      assertMutationApplied()
      expect(result.verdict).toBe('killed')
    })
  }

  for (const { id, scenario, reference } of referencePilots) {
    it.skipIf(!process.env.RPC_FOUNDATION_REFERENCE_ROOT)(`${id}: rejects bcba08b3e4`, async () => {
      const { adapters } = pilotMountAdapters(process.env.RPC_FOUNDATION_REFERENCE_ROOT!, {
        reference: true
      })

      const result = await runRecording(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler()
      )

      expect(visibleState(result)).toEqual(reference)
      expect(reference).not.toEqual(visibleState(readGolden(goldens, id).recording))
    })
  }
})
