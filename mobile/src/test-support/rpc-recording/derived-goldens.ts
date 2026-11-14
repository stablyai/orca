import { materializeScenario } from './scenario-execution-mode'
import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import { bindCompletions, lifecycleSchedules } from './schedule-driver'
import type { RecordingScenario, ExecutionMode, ScenarioLineage } from './recording-scenario'

// Share derivation with census/pruning so all consumers enumerate the recordings actually written.
// Prefix titles with golden ids so rpc:record can select by test name.
export type DerivedGolden = {
  id: string
  title: string
  family: string
  lineage: ScenarioLineage
  scenarios: () => RecordingScenario[]
}

const LIFECYCLE_BASES = [
  'inventory-lifecycle',
  'b3',
  'settings-bot-overrides-fulfilled',
  'settings-workspace-context-fulfilled',
  'settings-task-hydration-fulfilled'
]

function baseScenario(manifest: readonly RecordingScenario[], id: string): RecordingScenario {
  const found = manifest.find((scenario) => scenario.id === id)
  if (!found) {
    throw new Error(`No scenario named ${id}`)
  }
  return found
}

function omitRetiredInventoryAdmission(scenario: RecordingScenario): RecordingScenario {
  if (
    scenario.id !== 'inventory-lifecycle.unmount-before-1' &&
    scenario.id !== 'inventory-lifecycle.reset-before-1'
  ) {
    return scenario
  }
  // A late search refusal cannot start an inventory after its owner retires.
  return {
    ...scenario,
    steps: scenario.steps.filter(
      (step) =>
        !(
          ('bind' in step &&
            (step.bind === 'old-inventory' || step.bind === 'lifecycle-old-inventory')) ||
          ('complete' in step && step.complete === 'lifecycle-old-inventory')
        )
    )
  }
}

export type PilotGolden = DerivedGolden & { scenario: RecordingScenario }

export function pilotGoldens(
  manifest: readonly RecordingScenario[],
  mode: ExecutionMode = 'native'
): PilotGolden[] {
  return manifest
    .map((source) => materializeScenario(source, mode))
    .map((scenario) => ({
      id: scenario.id,
      title: `${scenario.id}: replays its recording deterministically`,
      family: scenario.family,
      lineage: scenario.lineage!,
      scenario,
      scenarios: () => [scenario]
    }))
}

export function familyGoldens(
  input: readonly RecordingScenario[],
  mode: ExecutionMode = 'native'
): DerivedGolden[] {
  const manifest = input.map((scenario) => materializeScenario(scenario, mode))
  const goldens: DerivedGolden[] = []
  for (const id of LIFECYCLE_BASES) {
    const base = baseScenario(manifest, id)
    const actions: readonly ('reset' | 'unmount' | 'blur')[] = id.includes('hydration')
      ? ['unmount']
      : id.includes('context')
        ? ['unmount', 'blur']
        : ['reset', 'unmount']
    goldens.push({
      id: `lifecycle-${id}`,
      title: `lifecycle-${id}: lifecycle boundaries`,
      family: base.family,
      lineage: { ...base.lineage!, schedule: 'lifecycle' },
      scenarios: () =>
        hoistPreludeCheckpoints(
          { ...base, steps: bindCompletions(base.steps) },
          actions
            .flatMap((action) => lifecycleSchedules(base, action))
            .filter(({ scenario }) => !id.includes('hydration') || !scenario.id.endsWith('-1'))
        ).map(omitRetiredInventoryAdmission)
    })
  }
  return goldens
}

export function derivedGoldens(
  manifest: readonly RecordingScenario[],
  mode: ExecutionMode = 'native'
): DerivedGolden[] {
  return [...pilotGoldens(manifest, mode), ...familyGoldens(manifest, mode)]
}
