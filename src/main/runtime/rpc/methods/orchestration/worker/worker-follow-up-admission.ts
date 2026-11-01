import type { OrchestrationAdmission } from '../../../../orchestration/orchestration-admission'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { createDispatchCreatorEvaluation } from '../../../../orchestration/db/dispatch-creator-evaluation'
import { selectWorkerFollowUpPlan } from '../../../../orchestration/db/dispatch-context/worker-follow-up-plan'
import { existingWorkerStartRunAdmission } from './worker-start-run-authority'
import {
  createHelperStartScope,
  type HelperDispatch,
  type HelperReaders
} from './helper-start-scope'

export function planSemanticWorkerFollowUp<
  D extends { id: string; status: string; follow_up_of_dispatch_id: string | null },
  R extends { owner_dispatch_id: string; origin_dispatch_id: string }
>(addressedId: string, ...args: Parameters<typeof selectWorkerFollowUpPlan<D, R>>) {
  const plan = selectWorkerFollowUpPlan(...args)
  return plan?.kind === 'start' ? { ...plan, addressed: addressedId } : plan
}

export function workerFollowUpArguments(plan: {
  addressed: string
  latest: { id: string }
  resource: { owner_dispatch_id: string } | undefined
}) {
  return {
    of: plan.latest.id,
    addressed: plan.addressed,
    ...(plan.resource ? { custodian: plan.resource.owner_dispatch_id } : {})
  }
}

/** One synchronous semantic composition; raw reads may throw and are never classified by error code. */
export function createWorkerFollowUpQualification<
  R extends { id: string; legacy: number },
  D extends HelperDispatch
>(
  read: HelperReaders<D> & {
    coordinated: () => R | undefined
    named: (id: string) => R | undefined
    run: (id: string) => R | undefined
    caller: () => ReturnType<typeof createDispatchCreatorEvaluation>
    maxDepth: () => number
  }
) {
  let caller: ReturnType<typeof createDispatchCreatorEvaluation> | undefined
  const roles = () => (caller ??= read.caller())
  const helpers = new Map<string, ReturnType<typeof createHelperStartScope<D>>>()
  return (
    runId: string,
    followUp: ReturnType<typeof workerFollowUpArguments>
  ): OrchestrationAdmission<{ run: R; creator?: D }> => {
    let failure: Error | undefined
    const selected = existingWorkerStartRunAdmission(
      read.coordinated(),
      runId,
      () => read.named(runId),
      () => {
        const id = roles().creatorId()
        if (id.kind === 'refused') {
          failure = id.error
          return undefined
        }
        const creator = id.value ? read.dispatch(id.value) : undefined
        const run = creator ? read.run(creator.run_id) : undefined
        return creator && run ? { creator, run } : undefined
      }
    )
    if (failure) {
      return { kind: 'refused', error: failure }
    }
    if (selected.kind === 'refused') {
      return selected
    }
    if (!selected.value) {
      return {
        kind: 'refused',
        error: new OrchestrationError(
          'consumer_fenced',
          'worker-start needs the coordinator bound to the Run, or a worker on an active Dispatch in it.'
        )
      }
    }
    const { creator } = selected.value
    if (creator) {
      let helper = helpers.get(creator.id)
      if (!helper) {
        helper = createHelperStartScope(read, creator)
        helpers.set(creator.id, helper)
      }
      const scope = helper({ task: undefined, params: {}, followUp })
      if (scope.kind === 'refused') {
        return scope
      }
    }
    const depth = roles().childDepth(read.maxDepth())
    return depth.kind === 'refused' ? depth : { kind: 'admitted', value: selected.value }
  }
}
