import {
  requireOrchestrationAdmission,
  type OrchestrationAdmission
} from '../../../../orchestration/orchestration-admission'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/** Existing-Run authority is shared; binding/creation and placement remain command effects. */
export function existingWorkerStartRunAdmission<
  R extends { id: string; legacy: number },
  D extends { id: string }
>(
  coordinated: R | undefined,
  runId: string | undefined,
  named: () => R | undefined,
  delegated: () => { creator: D; run: R } | undefined
): OrchestrationAdmission<{ run: R; creator?: D } | undefined> {
  if (coordinated) {
    const run = runId ? named() : coordinated
    if (!run) {
      return {
        kind: 'refused',
        error: fenced(`This caller coordinates Run ${coordinated.id}, not ${runId}.`)
      }
    }
    return { kind: 'admitted', value: { run } }
  }
  const helper = delegated()
  if (helper && helper.run.legacy !== 1) {
    if (runId && runId !== helper.run.id) {
      return {
        kind: 'refused',
        error: fenced(
          `This worker's Dispatch ${helper.creator.id} is in Run ${helper.run.id}; it starts helpers only there.`
        )
      }
    }
    return { kind: 'admitted', value: helper }
  }
  return { kind: 'admitted', value: undefined }
}

function fenced(message: string): OrchestrationError {
  return new OrchestrationError('consumer_fenced', message)
}

export function selectExistingWorkerStartRun<
  R extends { id: string; legacy: number },
  D extends { id: string }
>(
  ...args: Parameters<typeof existingWorkerStartRunAdmission<R, D>>
): { run: R; creator?: D } | undefined {
  return requireOrchestrationAdmission(existingWorkerStartRunAdmission(...args))
}
