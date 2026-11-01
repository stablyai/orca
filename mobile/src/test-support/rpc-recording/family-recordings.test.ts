import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readScenarios } from './scenario-input'
import { familyGoldens } from './derived-goldens'
import { runRecording } from './run-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { expectGoldenFile, goldenBytes, goldenRecording, writeGolden } from './golden-recording'
import type { Recording, RecordingScenario } from './recording-scenario'
import { determinismRuns } from './determinism-runs'

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')
async function certify(id: string, scenarios: RecordingScenario[]) {
  let first = ''
  for (let run = 0; run < determinismRuns(); run++) {
    const checkpoints: Recording['checkpoints'] = []
    for (const scenario of scenarios) {
      const { adapters } = pilotMountAdapters(root, { device: scenario })
      const recording = await runRecording(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler()
      )
      for (const checkpoint of recording.checkpoints) {
        checkpoints.push({ ...checkpoint, id: `${scenario.id}:${checkpoint.id}` })
      }
    }
    const golden = goldenRecording(scenarios, { scenario: id, checkpoints })
    const bytes = goldenBytes(golden)
    if (run) {
      expect(bytes).toBe(first)
    } else if (process.env.RPC_FOUNDATION_MODE === '--record') {
      await writeGolden(directory, golden, '--record')
    } else {
      await expectGoldenFile(directory, id, golden)
    }
    first = bytes
  }
}

describe('family reply partitions and owned schedules', () => {
  const goldens = familyGoldens(input.scenarios)
  for (const golden of goldens) {
    it(
      golden.title,
      async () => {
        await certify(golden.id, golden.scenarios())
      },
      golden.timeoutMs
    )
  }
})
