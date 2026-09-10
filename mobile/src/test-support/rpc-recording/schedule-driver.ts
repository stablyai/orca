import type { RecordingScenario, ScenarioStep } from './recording-scenario'

type Completion = Extract<ScenarioStep, { complete: string }>
export const REQUIRED_SCHEDULES = [
  'forward',
  'reverse',
  'reset-before-first',
  'reset-after-first',
  'reset-before-second',
  'reset-after-second',
  'a-b-a',
  'stale-inflight-cleanup',
  'unmount-remount',
  'blur-retained-route',
  'client-cutover',
  'timeout',
  'disconnect',
  'both-reject-forward',
  'both-reject-reverse',
  'reject-peer-pending'
] as const

export function siblingSchedules(
  base: RecordingScenario,
  first: Completion,
  second: Completion
): RecordingScenario[] {
  const firstIndex = base.steps.indexOf(first)
  const secondIndex = base.steps.indexOf(second)
  if (firstIndex === -1 || secondIndex < firstIndex) {
    throw new Error('Sibling completions must be ordered members of the base scenario')
  }
  const prefix = base.steps.slice(0, firstIndex).filter((step) => !('checkpoint' in step))
  const suffix = base.steps.slice(secondIndex + 1).filter((step) => !('checkpoint' in step))
  const checkpoint = { checkpoint: 'sibling-pending' }
  const rejected = (step: Completion): Completion => ({
    complete: step.complete,
    params: step.params,
    reject: { message: `${step.complete} rejected`, deliveryUnknown: true }
  })
  const variants: Record<string, ScenarioStep[]> = {
    forward: [first, checkpoint, second],
    reverse: [second, checkpoint, first],
    'both-reject-forward': [rejected(first), checkpoint, rejected(second)],
    'both-reject-reverse': [rejected(second), checkpoint, rejected(first)],
    'reject-peer-pending': [rejected(first), checkpoint],
    timeout: [{ advance: 30_000 }],
    disconnect: [{ action: 'disconnect', id: 'disconnect' }],
    'client-cutover': [{ action: 'cutover', id: 'cutover' }]
  }
  return Object.entries(variants).map(([schedule, steps]) => ({
    ...base,
    id: `${base.id}.${schedule}`,
    schedules: [schedule],
    steps: [...prefix, ...steps, ...suffix, { checkpoint: 'settled' }]
  }))
}

export function lifecycleSchedules(
  base: RecordingScenario,
  action: 'reset' | 'unmount' | 'blur'
): RecordingScenario[] {
  const completions = base.steps.flatMap((step, index) => ('complete' in step ? [index] : []))
  return completions.flatMap((index, occurrence) =>
    ['before', 'after'].map((side) => {
      const steps = [...base.steps]
      steps.splice(
        index + (side === 'after' ? 1 : 0),
        0,
        { action, id: `lifecycle-${action}` },
        { checkpoint: 'lifecycle-boundary' }
      )
      if (action === 'unmount') {
        steps.push({ action: 'remount', id: 'remount' }, { checkpoint: 'remounted' })
      }
      const boundSteps = steps.flatMap((step): ScenarioStep[] =>
        'complete' in step
          ? [
              { bind: `lifecycle-${step.complete}`, request: step.complete, params: step.params },
              { ...step, complete: `lifecycle-${step.complete}` }
            ]
          : [step]
      )
      return {
        ...base,
        id: `${base.id}.${action}-${side}-${occurrence + 1}`,
        schedules: [`${action}-${side}-${occurrence + 1}`],
        steps: boundSteps
      }
    })
  )
}

export function interruptionSchedules(base: RecordingScenario): RecordingScenario[] {
  const completion = base.steps.findLastIndex((step) => 'complete' in step)
  if (completion === -1) {
    throw new Error('Interruption schedule needs an in-flight request')
  }
  return ['timeout', 'disconnect', 'cutover'].map((interruption) => ({
    ...base,
    id: `${base.id}.${interruption}`,
    schedules: [interruption],
    steps: [
      ...base.steps.slice(0, completion),
      interruption === 'timeout' ? { advance: 30_000 } : { action: interruption, id: interruption },
      { checkpoint: 'interrupted' },
      ...base.steps.slice(completion)
    ]
  }))
}
