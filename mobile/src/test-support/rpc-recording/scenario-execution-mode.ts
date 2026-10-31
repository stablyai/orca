import type { ExecutionMode, RecordingScenario, ScenarioStep } from './recording-scenario'

// Select actual input steps before deriving sites or schedules; qualifiers never grant optionality.
export function materializeScenario(
  scenario: RecordingScenario,
  mode: ExecutionMode
): RecordingScenario {
  if (scenario.lineage && scenario.lineage.mode !== mode) {
    throw new Error(`Cannot reinterpret materialized ${scenario.id} as ${mode}`)
  }
  if (scenario.lineage) {
    return scenario
  }
  const aliases = new Set(scenario.steps.flatMap((step) => ('bind' in step ? [step.bind] : [])))
  const steps = scenario.steps
    .map((step, index) => ({ ...step, site: step.site ?? `${scenario.id}:steps[${index}]` }))
    .filter((step) => step.transport === undefined || step.transport === mode)
    .map((step): ScenarioStep => {
      const { transport: _transport, ...selected } = step
      if ('complete' in selected) {
        return {
          ...selected,
          site: selected.site ?? selected.complete,
          complete:
            mode === 'bridge' && step.transport === undefined && !aliases.has(selected.complete)
              ? `${selected.complete}.native-1`
              : selected.complete
        }
      }
      if ('bind' in selected && mode === 'bridge' && step.transport === undefined) {
        return { ...selected, request: `${selected.request}.native-1` }
      }
      return selected
    })
  return { ...scenario, steps, lineage: { baseScenario: scenario.id, mode, domain: 'paired' } }
}
