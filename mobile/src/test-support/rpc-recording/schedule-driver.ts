import { hoistPreludeCheckpoints, type DivergingScenario } from './prelude-checkpoints'
import type { RecordingScenario, ScenarioStep } from './recording-scenario'

type Completion = Extract<ScenarioStep, { complete: string }>
/**
 * Requests are issued with a 30 s deadline. One jump past it records the same partition whatever the
 * deadline is; two jumps with a checkpoint between them put a partition on each side, so shortening
 * or lengthening the real deadline moves an observation.
 */
const REQUEST_DEADLINE_STRADDLE: ScenarioStep[] = [
  { advance: 11_000 },
  { checkpoint: 'deadline-pending' },
  { advance: 19_000 }
]
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
    timeout: REQUEST_DEADLINE_STRADDLE,
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

/** Completions are rebound so a lifecycle boundary can land between a request and its reply. */
export function bindCompletions(steps: readonly ScenarioStep[]): ScenarioStep[] {
  return steps.flatMap((step): ScenarioStep[] =>
    'complete' in step
      ? [
          { bind: `lifecycle-${step.complete}`, request: step.complete, params: step.params },
          { ...step, complete: `lifecycle-${step.complete}` }
        ]
      : [step]
  )
}

export function lifecycleSchedules(
  base: RecordingScenario,
  action: 'reset' | 'unmount' | 'blur'
): DivergingScenario[] {
  const completions = base.steps.flatMap((step, index) => ('complete' in step ? [index] : []))
  return completions.flatMap((index, occurrence) =>
    ['before', 'after'].map((side) => {
      const insertion = index + (side === 'after' ? 1 : 0)
      const steps = [...base.steps]
      steps.splice(
        insertion,
        0,
        { action, id: `lifecycle-${action}` },
        { checkpoint: 'lifecycle-boundary' }
      )
      if (action === 'unmount') {
        steps.push({ action: 'remount', id: 'remount' }, { checkpoint: 'remounted' })
      }
      return {
        divergence: bindCompletions(base.steps.slice(0, insertion)).length,
        scenario: {
          ...base,
          id: `${base.id}.${action}-${side}-${occurrence + 1}`,
          schedules: [`${action}-${side}-${occurrence + 1}`],
          steps: bindCompletions(steps)
        }
      }
    })
  )
}

export function interruptionSchedules(base: RecordingScenario): RecordingScenario[] {
  const completion = base.steps.findLastIndex((step) => 'complete' in step)
  if (completion === -1) {
    throw new Error('Interruption schedule needs an in-flight request')
  }
  return hoistPreludeCheckpoints(
    base,
    ['timeout', 'disconnect', 'cutover'].map((interruption) => ({
      divergence: completion,
      scenario: {
        ...base,
        id: `${base.id}.${interruption}`,
        schedules: [interruption],
        steps: [
          ...base.steps.slice(0, completion),
          ...(interruption === 'timeout'
            ? REQUEST_DEADLINE_STRADDLE
            : [{ action: interruption, id: interruption }]),
          { checkpoint: 'interrupted' },
          ...base.steps.slice(completion)
        ]
      }
    }))
  )
}
