import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import { driveReplyMatrix, replyMatrixGoldenId, replyMatrixSites } from './reply-matrix'
import { replyMatrixNormalResult } from './reply-matrix-normal-result'
import {
  bindCompletions,
  interruptionSchedules,
  lifecycleSchedules,
  siblingSchedules
} from './schedule-driver'
import type { RecordingScenario } from './recording-scenario'

/**
 * One frozen golden and the scenarios it is recorded from. Derived here rather than inside the
 * suites so `scenarioSha256` is a function of the same derivation that records the file: a test
 * that restated how a matrix or schedule expands could agree with itself while disagreeing with
 * what was recorded.
 */
export type DerivedGolden = {
  id: string
  title: string
  family: string
  /** The matrix site this golden drives; absent for a pilot or schedule golden. */
  site?: string
  /** Lazy, so a family with no replayable success fails its own test instead of collection. */
  scenarios: () => RecordingScenario[]
  timeoutMs?: number
}

const SIBLING_SCHEDULE_BASES = [
  'b3',
  'settings-new-tab-ssh',
  'settings-home-providers-fulfilled',
  'settings-workspace-context-fulfilled',
  'settings-resume-metadata-fulfilled',
  'settings-task-hydration-fulfilled',
  'settings-repo-metadata-fulfilled'
]

const INTERRUPTION_BASES = ['inventory-lifecycle', 'settings-bot-overrides-fulfilled']

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

/** The manifest scenario a pilot golden expands from, which its suite also mounts and mutates. */
export type PilotGolden = DerivedGolden & { scenario: RecordingScenario }

/** One golden per manifest scenario: frozen main parity for the scenario as written. */
export function pilotGoldens(manifest: readonly RecordingScenario[]): PilotGolden[] {
  return manifest.map((scenario) => ({
    id: scenario.id,
    title: `${scenario.id}: frozen main parity and determinism`,
    family: scenario.family,
    scenario,
    scenarios: () => [scenario]
  }))
}

/** Every golden generated from a family's base scenario: reply matrices and owned schedules. */
export function familyGoldens(manifest: readonly RecordingScenario[]): DerivedGolden[] {
  const families = new Map<string, RecordingScenario[]>()

  for (const scenario of manifest) {
    families.set(scenario.family, [...(families.get(scenario.family) ?? []), scenario])
  }

  const goldens: DerivedGolden[] = []
  const ids = new Set<string>()

  for (const [family, scenarios] of families) {
    const [base] = scenarios

    if (!base) {
      throw new Error(`Family has no scenario: ${family}`)
    }

    for (const site of replyMatrixSites(base)) {
      const id = replyMatrixGoldenId(family, site)

      if (ids.has(id)) {
        throw new Error(`Two matrix sites share a golden: ${id}`)
      }

      ids.add(id)
      goldens.push({
        id,
        title: `${family}: reply partitions at ${site}`,
        family,
        site,
        timeoutMs: 30_000,
        scenarios: () =>
          driveReplyMatrix(base, site, replyMatrixNormalResult(family, scenarios, site))
      })
    }
  }

  for (const id of SIBLING_SCHEDULE_BASES) {
    const base = baseScenario(manifest, id)
    const replies = base.steps.flatMap((step) => ('complete' in step ? [step] : []))

    // Complete prerequisites before permuting the sibling barrier.
    const first = replies.find((step) =>
      step.complete.startsWith(id === 'b3' ? 'linear.getIssue' : 'settings.get')
    )

    if (!first) {
      throw new Error(`No prerequisite completion to order siblings against: ${id}`)
    }

    const second = replies[replies.indexOf(first) + 1]

    if (!second) {
      continue
    }

    goldens.push({
      id: `schedules-${id}`,
      title: `${id}: completion orders and correlated faults`,
      family: base.family,
      scenarios: () => siblingSchedules(base, first, second)
    })
  }

  for (const id of INTERRUPTION_BASES) {
    const base = baseScenario(manifest, id)
    goldens.push({
      id: `interruptions-${id}`,
      title: `${id}: timeout, disconnect and stable-client cutover`,
      family: base.family,
      scenarios: () => interruptionSchedules(base)
    })
  }

  for (const id of LIFECYCLE_BASES) {
    const base = baseScenario(manifest, id)

    const actions: readonly ('reset' | 'unmount' | 'blur')[] = id.includes('hydration')
      ? ['unmount']
      : id.includes('context')
        ? ['unmount', 'blur']
        : ['reset', 'unmount', 'blur']

    goldens.push({
      id: `lifecycle-${id}`,
      title: `${id}: lifecycle boundaries`,
      family: base.family,
      scenarios: () =>
        hoistPreludeCheckpoints(
          { ...base, steps: bindCompletions(base.steps) },
          actions
            .flatMap((action) => lifecycleSchedules(base, action))
            .filter(({ scenario }) => !id.includes('hydration') || !scenario.id.endsWith('-1'))
        )
    })
  }

  return goldens
}

/** Every golden the oracle freezes, pilot and family alike. */
export function derivedGoldens(manifest: readonly RecordingScenario[]): DerivedGolden[] {
  return [...pilotGoldens(manifest), ...familyGoldens(manifest)]
}
