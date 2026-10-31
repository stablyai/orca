import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/** Existing-Run authority is shared; binding/creation and placement remain command effects. */
export function selectExistingWorkerStartRun<
  R extends { id: string; legacy: number },
  D extends { id: string }
>(
  coordinated: R | undefined,
  runId: string | undefined,
  named: () => R | undefined,
  delegated: () => { creator: D; run: R } | undefined
): { run: R; creator?: D } | undefined {
  if (coordinated) {
    const run = runId ? named() : coordinated
    if (!run) {
      throw fenced(`This caller coordinates Run ${coordinated.id}, not ${runId}.`)
    }
    return { run }
  }
  const helper = delegated()
  if (helper && helper.run.legacy !== 1) {
    if (runId && runId !== helper.run.id) {
      throw fenced(
        `This worker's Dispatch ${helper.creator.id} is in Run ${helper.run.id}; it starts helpers only there.`
      )
    }
    return helper
  }
  return undefined
}

function fenced(message: string): OrchestrationError {
  return new OrchestrationError('consumer_fenced', message)
}
