import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readScenarios } from './scenario-input'
import { driveReplyMatrix } from './reply-matrix'
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

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')
const settingsNormal = {
  settings: {
    disabledTuiAgents: ['claude'],
    defaultTuiAgent: 'codex',
    prBotAuthorOverrides: ['recorded-bot'],
    visibleTaskProviders: ['github'],
    hostSettingOverrides: {},
    defaultTaskSource: 'github',
    defaultTaskViewPreset: 'all',
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    githubProjects: {}
  }
}

async function certify(id: string, scenarios: RecordingScenario[]) {
  let first = ''
  for (let run = 0; run < Number(process.env.RPC_FOUNDATION_DETERMINISM_RUNS ?? 2); run++) {
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
  const families = new Map<string, RecordingScenario>()
  for (const scenario of input.scenarios) {
    if (!families.has(scenario.family)) {
      families.set(scenario.family, scenario)
    }
  }
  for (const [family, base] of families) {
    const completion = base.steps.find(
      (step) =>
        'complete' in step &&
        (step.complete.startsWith('settings.') ||
          (base.id === 'b1' && step.complete === 'fresh-inventory') ||
          (base.id === 'b2' && step.complete.startsWith('github.project.')) ||
          (base.id === 'b3' && step.complete.startsWith('linear.getIssue')))
    )
    if (!completion || !('complete' in completion)) {
      continue
    }
    const normal =
      base.id === 'b1'
        ? { files: [{ relativePath: 'third.ts' }] }
        : base.id === 'b3'
          ? { id: 'issue-1', description: 'recorded', labels: [], subIssues: [] }
          : completion.complete.startsWith('settings.get')
            ? settingsNormal
            : { ok: true }
    const settingsFields: Record<string, string[]> = {
      'settings.new-tab-agents': ['disabledTuiAgents', 'defaultTuiAgent'],
      'settings.bot-overrides': ['prBotAuthorOverrides'],
      'settings.workspace-context': ['visibleTaskProviders'],
      'settings.home-providers': ['visibleTaskProviders'],
      'settings.resume-metadata': [],
      'settings.repo-metadata': ['hostSettingOverrides'],
      'settings.task-hydration': [
        'visibleTaskProviders',
        'defaultTaskSource',
        'defaultTaskViewPreset',
        'defaultRepoSelection',
        'defaultLinearTeamSelection',
        'githubProjects'
      ],
      'settings.workspace-submit': ['disabledTuiAgents', 'defaultTuiAgent'],
      'settings.task-workspace': ['disabledTuiAgents', 'defaultTuiAgent']
    }
    const fields =
      base.id === 'b1'
        ? [['files']]
        : base.id === 'b3'
          ? [['description'], ['labels'], ['subIssues']]
          : completion.complete.startsWith('settings.get')
            ? [
                ['settings'],
                ...(settingsFields[base.operation] ?? []).map((field) => ['settings', field])
              ]
            : completion.complete.startsWith('settings.update')
              ? []
              : [['ok']]
    it(`${family}: reply partitions once per family`, async () => {
      await certify(`matrix-${family}`, driveReplyMatrix(base, completion.complete, normal, fields))
    }, 30_000)
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
    if (second) {
      it(`${id}: completion orders and correlated faults`, async () => {
        await certify(`schedules-${id}`, siblingSchedules(base, first, second))
      })
    }
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
