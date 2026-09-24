import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readScenarios } from './scenario-input'
import { familyGoldens } from './derived-goldens'
import { REPLY_MATRIX_NORMAL_RESULT_INVENTORY } from './reply-matrix-normal-result'
import { runRecording } from './run-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import {
  compareGolden,
  goldenBytes,
  goldenRecording,
  readGolden,
  writeGolden
} from './golden-recording'
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
    const golden = goldenRecording(root, input.baseline, scenarios, {
      scenario: id,
      checkpoints
    })
    const bytes = goldenBytes(golden)
    if (run) {
      expect(bytes).toBe(first)
    }
    first = bytes
    if (process.env.RPC_FOUNDATION_MODE === '--record') {
      await writeGolden(directory, golden, '--record')
    } else {
      compareGolden(readGolden(directory, id), golden)
    }
  }
}

describe('family reply partitions and owned schedules', () => {
  const goldens = familyGoldens(input.scenarios)
  const families = [...new Set(input.scenarios.map((scenario) => scenario.family))]
  // Read off the goldens that actually generate a test, so the census is independent of whether
  // replyMatrixSites would throw on an empty list: the mechanism this replaced skipped families.
  const sites = goldens.flatMap((golden) => (golden.site ? [golden] : []))
  it('matrices every family in the manifest', () => {
    expect([...new Set(sites.map((golden) => golden.family))]).toEqual(families)
  })
  // The inventory is only consulted for a live site, so a stale entry would retire silently.
  it('lists only live matrix sites in the normal-result inventory', () => {
    const live = new Set(sites.map((golden) => `${golden.family}\0${golden.site}`))
    const stale = REPLY_MATRIX_NORMAL_RESULT_INVENTORY.filter(
      (entry) => !live.has(`${entry.family}\0${entry.request}`)
    ).map((entry) => `${entry.family} ${entry.request}`)
    expect(stale).toEqual([])
  })
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
