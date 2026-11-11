import { hoistPreludeCheckpoints, type DivergingScenario } from './prelude-checkpoints'
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

// The sibling timeout (their default 30-second deadline, as the goldens record), the disconnect and the client
// cutover all end these before their replies arrive.
const SIBLING_INTERRUPTION_LATE_REPLIES: Readonly<Record<string, readonly string[]>> = {
  'settings-workspace-context-fulfilled': ['preflight.check#1', 'linear.status#1', 'jira.status#1'],
  'settings-task-hydration-fulfilled': ['preflight.check#1', 'linear.status#1', 'jira.status#1']
}

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
    ...step,
    reply: undefined,
    // The stable logical site names the request in every execution mode.
    reject: { message: `${step.site ?? step.complete} rejected`, deliveryUnknown: true }
  })
  // Only the declared replies the interruption has already ended arrive late; the rest stay live.
  const lateAfterInterruption =
    SIBLING_INTERRUPTION_LATE_REPLIES[base.lineage?.baseScenario ?? base.id] ?? []
  const interruptedSuffix = suffix.map((step): ScenarioStep =>
    'complete' in step && lateAfterInterruption.includes(step.site ?? step.complete)
      ? { ...step, late: true }
      : step
  )
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
    ...(base.lineage ? { lineage: { ...base.lineage, schedule } } : {}),
    steps: [
      ...prefix,
      ...steps,
      ...(schedule === 'timeout' || schedule === 'disconnect' || schedule === 'client-cutover'
        ? interruptedSuffix
        : suffix),
      { checkpoint: 'settled' }
    ]
  }))
}

export function bindCompletions(steps: readonly ScenarioStep[]): ScenarioStep[] {
  return steps.flatMap((step): ScenarioStep[] =>
    'complete' in step
      ? [
          {
            bind: `lifecycle-${step.complete}`,
            request: step.complete,
            params: step.params,
            site: step.site,
            transport: step.transport,
            optional: step.optional
          },
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
          ...(base.lineage
            ? {
                lineage: {
                  ...base.lineage,
                  schedule: `${action}-${side}`,
                  site: base.steps[index]?.site
                }
              }
            : {}),
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
        ...(base.lineage ? { lineage: { ...base.lineage, schedule: interruption } } : {}),
        steps: [
          ...base.steps.slice(0, completion),
          interruption === 'timeout'
            ? { advance: 30_000 }
            : { action: interruption, id: interruption },
          { checkpoint: 'interrupted' },
          // Each interruption ends the in-flight request (timed out, lost, or interrupted by the migration), so
          // its scripted reply now arrives late.
          ...base.steps
            .slice(completion)
            .map((step, index): ScenarioStep => (index === 0 ? { ...step, late: true } : step))
        ]
      }
    }))
  )
}
