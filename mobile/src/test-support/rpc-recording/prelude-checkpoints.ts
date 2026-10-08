import type { RecordingScenario, ScenarioStep } from './recording-scenario'

/** A generated variant plus the index in its own step list where its distinguishing input lands. */
export type DivergingScenario = { scenario: RecordingScenario; divergence: number }

function stepsKey(steps: readonly ScenarioStep[]): string {
  // The replacer keeps an explicit-undefined param distinct from an absent one.
  return JSON.stringify(steps, (_key, value: unknown) =>
    value === undefined ? '$undefined' : value
  )
}

/**
 * A checkpoint before a variant's divergence observes steps identical to the base, so every variant
 * would record the same value. Record those once in a prelude and let each variant start at its own
 * divergence; checkpoints that merely happen to be equal are left alone.
 */
export function hoistPreludeCheckpoints(
  base: RecordingScenario,
  variants: readonly DivergingScenario[]
): RecordingScenario[] {
  if (!variants.length) {
    throw new Error(`No variants to hoist: ${base.id}`)
  }
  for (const { scenario, divergence } of variants) {
    if (
      stepsKey(scenario.steps.slice(0, divergence)) !== stepsKey(base.steps.slice(0, divergence))
    ) {
      throw new Error(`Variant diverges from the base before its divergence index: ${scenario.id}`)
    }
  }
  const shared = Math.max(...variants.map((variant) => variant.divergence))
  const preludeSteps = base.steps.slice(0, shared)
  const scenarios: RecordingScenario[] = []
  if (preludeSteps.some((step) => 'checkpoint' in step)) {
    scenarios.push({
      ...base,
      id: `${base.id}.prelude`,
      schedules: ['prelude'],
      steps: preludeSteps
    })
  }
  for (const { scenario, divergence } of variants) {
    const steps = scenario.steps.filter(
      (step, index) => !('checkpoint' in step) || index >= divergence
    )
    if (!steps.some((step) => 'checkpoint' in step)) {
      throw new Error(`Variant has no checkpoint at or after its divergence: ${scenario.id}`)
    }
    scenarios.push({ ...scenario, steps })
  }
  return scenarios
}
