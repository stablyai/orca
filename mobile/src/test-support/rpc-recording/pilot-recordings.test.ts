import { readScenarios } from './scenario-input'
import { pilotGoldens } from './derived-goldens'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runRecording } from './run-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { expectGoldenFile, goldenBytes, goldenRecording, writeGolden } from './golden-recording'
import type { Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'
import { determinismRuns } from './determinism-runs'

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const goldens = process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')
function visibleState(recording: Recording): RecordedValue {
  return recording.checkpoints.at(-1)!.observation.state
}

describe('RPC main recordings', () => {
  for (const pilot of pilotGoldens(input.scenarios)) {
    const { id, scenario } = pilot
    it(pilot.title, async () => {
      let first = ''
      for (let run = 0; run < determinismRuns(); run++) {
        const { adapters } = pilotMountAdapters(root, { device: scenario })
        const recording = await runRecording(
          scenario,
          adapters[scenario.operation],
          vitestRecordingScheduler()
        )
        if (id === 'b1') {
          expect(visibleState(recording)).toEqual({ files: ['third.ts'] })
        }
        if (id === 'b2') {
          // The checked reader must name the null reply and method instead of exposing a property-read exception.
          expect(visibleState(recording)).toMatchObject({
            error:
              'The host sent a reply this app could not read (github.project.updateIssueBySlug)'
          })
        }
        if (id === 'b3') {
          expect(visibleState(recording)).toMatchObject({
            error: 'comments transport error',
            loading: false
          })
        }
        if (id === 'settings-task-hydration-fulfilled') {
          expect(visibleState(recording)).toMatchObject({ hydrated: true })
        }
        const golden = goldenRecording(pilot.scenarios(), recording)
        const bytes = goldenBytes(golden)
        if (run) {
          expect(bytes).toBe(first)
        } else if (process.env.RPC_FOUNDATION_MODE === '--record') {
          await writeGolden(goldens, golden, '--record')
        } else {
          await expectGoldenFile(goldens, id, golden)
        }
        first = bytes
      }
    })
  }
})
