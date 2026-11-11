import { readScenarios } from './scenario-input'
import { pilotGoldens } from './derived-goldens'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runRecording } from './run-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { expectGoldenFile, goldenRecording, writeGolden } from './golden-recording'
import type { Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'

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
      const { adapters } = pilotMountAdapters(root, { device: scenario })
      const recording = await runRecording(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler({ producer: id, scenario: scenario.id, mode: 'native' })
      )
      if (id === 'b1') {
        expect(visibleState(recording)).toEqual({ files: ['third.ts'] })
      }
      if (id === 'b2') {
        // The checked reader must name the null reply and method instead of exposing a property-read exception.
        expect(visibleState(recording)).toMatchObject({
          error: 'The host sent a reply this app could not read (github.project.updateIssueBySlug)'
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
      await (process.env.RPC_FOUNDATION_MODE === '--record'
        ? writeGolden(goldens, golden, '--record')
        : expectGoldenFile(goldens, id, golden))
    })
  }
})
