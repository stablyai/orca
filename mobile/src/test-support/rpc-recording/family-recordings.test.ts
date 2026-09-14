import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readScenarios } from './scenario-input'
import { driveReplyMatrix, replyMatrixGoldenId, replyMatrixSites } from './reply-matrix'
import {
  REPLY_MATRIX_NORMAL_RESULT_INVENTORY,
  replyMatrixNormalResult
} from './reply-matrix-normal-result'
import {
  bindCompletions,
  interruptionSchedules,
  lifecycleSchedules,
  siblingSchedules
} from './schedule-driver'
import { hoistPreludeCheckpoints } from './prelude-checkpoints'
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
      const { adapters } = pilotMountAdapters(root)
      const recording = await runRecording(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler()
      )
      for (const checkpoint of recording.checkpoints) {
        checkpoints.push({ ...checkpoint, id: `${scenario.id}:${checkpoint.id}` })
      }
    }
    const golden = goldenRecording(root, input.baseline, scenarios[0], {
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
  const families = new Map<string, RecordingScenario[]>()
  for (const scenario of input.scenarios) {
    families.set(scenario.family, [...(families.get(scenario.family) ?? []), scenario])
  }
  const goldenIds = new Set<string>()
  // Filled only when a site actually generates a test, so the census below is independent of
  // replyMatrixSites throwing on an empty list: the mechanism this replaced skipped families.
  const matrixed = new Set<string>()
  const liveSites = new Set<string>()
  it('matrices every family in the manifest', () => {
    expect([...matrixed]).toEqual([...families.keys()])
  })
  // The inventory is only consulted for a live site, so a stale entry would retire silently.
  it('lists only live matrix sites in the normal-result inventory', () => {
    const stale = REPLY_MATRIX_NORMAL_RESULT_INVENTORY.filter(
      (entry) => !liveSites.has(`${entry.family}\0${entry.request}`)
    ).map((entry) => `${entry.family} ${entry.request}`)
    expect(stale).toEqual([])
  })
  for (const [family, scenarios] of families) {
    const base = scenarios[0]!
    for (const request of replyMatrixSites(base)) {
      const id = replyMatrixGoldenId(family, request)
      if (goldenIds.has(id)) {
        throw new Error(`Two matrix sites share a golden: ${id}`)
      }
      goldenIds.add(id)
      matrixed.add(family)
      liveSites.add(`${family}\0${request}`)
      it(`${family}: reply partitions at ${request}`, async () => {
        await certify(
          id,
          driveReplyMatrix(base, request, replyMatrixNormalResult(family, scenarios, request))
        )
      }, 30_000)
    }
  }
  for (const id of [
    'b3',
    'settings-new-tab-ssh',
    'settings-home-providers-fulfilled',
    'settings-workspace-context-fulfilled',
    'settings-resume-metadata-fulfilled',
    'settings-task-hydration-fulfilled',
    'settings-repo-metadata-fulfilled'
  ]) {
    const base = input.scenarios.find((scenario) => scenario.id === id)!
    const replies = base.steps.filter((step) => 'complete' in step)
    // Complete prerequisites before permuting the sibling barrier.
    const first = replies.find((step) =>
      step.complete.startsWith(id === 'b3' ? 'linear.getIssue' : 'settings.get')
    )!
    const second = replies[replies.indexOf(first) + 1]
    if (!second) {
      continue
    }
    it(`${id}: completion orders and correlated faults`, async () => {
      await certify(`schedules-${id}`, siblingSchedules(base, first, second))
    })
  }
  for (const id of ['inventory-lifecycle', 'settings-bot-overrides-fulfilled']) {
    const base = input.scenarios.find((scenario) => scenario.id === id)!
    it(`${id}: timeout, disconnect and stable-client cutover`, async () => {
      await certify(`interruptions-${id}`, interruptionSchedules(base))
    })
  }
  for (const id of [
    'inventory-lifecycle',
    'b3',
    'settings-bot-overrides-fulfilled',
    'settings-workspace-context-fulfilled',
    'settings-task-hydration-fulfilled'
  ]) {
    const base = input.scenarios.find((scenario) => scenario.id === id)!
    const actions = id.includes('hydration')
      ? (['unmount'] as const)
      : id.includes('context')
        ? (['unmount', 'blur'] as const)
        : (['reset', 'unmount', 'blur'] as const)
    it(`${id}: lifecycle boundaries`, async () => {
      await certify(
        `lifecycle-${id}`,
        hoistPreludeCheckpoints(
          { ...base, steps: bindCompletions(base.steps) },
          actions
            .flatMap((action) => lifecycleSchedules(base, action))
            .filter(({ scenario }) => !id.includes('hydration') || !scenario.id.endsWith('-1'))
        )
      )
    })
  }
})
