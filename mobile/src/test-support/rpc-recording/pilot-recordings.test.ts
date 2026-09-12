import { readScenarios } from './scenario-input'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runRecording, runRecordingMutant } from './run-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import {
  compareGolden,
  goldenBytes,
  goldenRecording,
  readGolden,
  writeGolden
} from './golden-recording'
import type { Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'
import type { Mutation } from './operation-mutations'

const root = resolve(import.meta.dirname, '../../../..')
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

describe('RPC main recordings', () => {
  for (const scenario of input.scenarios) {
    it(`${scenario.id}: frozen main parity and determinism`, async () => {
      let first = ''
      for (let run = 0; run < Number(process.env.RPC_FOUNDATION_DETERMINISM_RUNS ?? 2); run++) {
        const { adapters } = pilotMountAdapters(root)
        const recording = await runRecording(
          scenario,
          adapters[scenario.operation],
          vitestRecordingScheduler()
        )
        if (scenario.id === 'b1') {
          expect(visibleState(recording)).toEqual({ files: ['third.ts'] })
        }
        if (scenario.id === 'b2') {
          expect(visibleState(recording)).toMatchObject({
            error: "Cannot read properties of null (reading 'ok')"
          })
        }
        if (scenario.id === 'b3') {
          expect(visibleState(recording)).toMatchObject({
            error: 'comments transport error',
            loading: false
          })
        }
        const golden = goldenRecording(root, input.baseline, scenario, recording)
        const bytes = goldenBytes(golden)
        if (run) {
          expect(bytes).toBe(first)
        }
        first = bytes
        if (process.env.RPC_FOUNDATION_MODE === '--record') {
          await writeGolden(goldens, golden, '--record')
        } else {
          compareGolden(readGolden(goldens, scenario.id), golden)
        }
      }
    })
    const mutation = mutants[scenario.id]
    if (mutation) {
      it(`${scenario.id}: kills ${mutation}`, async () => {
        const { adapters, assertMutationApplied } = pilotMountAdapters(root, { mutation })
        const result = await runRecordingMutant(
          scenario,
          adapters[scenario.operation],
          vitestRecordingScheduler(),
          readGolden(goldens, scenario.id).recording,
          visibleState
        )
        assertMutationApplied()
        expect(result.verdict).toBe('killed')
      })
      const reference = referenceStates[scenario.id]
      if (reference) {
        it.skipIf(!process.env.RPC_FOUNDATION_REFERENCE_ROOT)(
          `${scenario.id}: rejects bcba08b3e4`,
          async () => {
            const { adapters } = pilotMountAdapters(process.env.RPC_FOUNDATION_REFERENCE_ROOT!, {
              reference: true
            })
            const result = await runRecording(
              scenario,
              adapters[scenario.operation],
              vitestRecordingScheduler()
            )
            expect(visibleState(result)).toEqual(reference)
            expect(reference).not.toEqual(visibleState(readGolden(goldens, scenario.id).recording))
          }
        )
      }
    }
  }
})
