/** One wait per Dispatch, in this runtime only: a restart ends it (see settleRestartCutWorkerStart). */
const waits = new Map<string, { controller: AbortController; ended: Promise<void> }>()

/** Starts `wait` as this Dispatch's background wait, ending any earlier one. */
export function registerWorkerStartWait(
  dispatchId: string,
  wait: (signal: AbortSignal) => Promise<void>
): void {
  cancelWorkerStartWait(dispatchId)
  const controller = new AbortController()
  const ended = wait(controller.signal).finally(() => {
    if (waits.get(dispatchId)?.controller === controller) {
      waits.delete(dispatchId)
    }
  })
  waits.set(dispatchId, { controller, ended })
}

/** A stop or abandon ends the wait; the Dispatch's own state already says why. */
export function cancelWorkerStartWait(dispatchId: string): void {
  waits.get(dispatchId)?.controller.abort()
}

const afterWaits = new Set<string>()

/** Runs `then` once this Dispatch's background wait has handed over, failed or been cancelled, however
 *  often it is asked for `purpose`: what a start's caller does after its receipt is done again then. */
export function afterWorkerStartWait(
  dispatchId: string,
  purpose: string,
  then: () => void | Promise<void>
): void {
  const ended = waits.get(dispatchId)?.ended
  const key = `${dispatchId}:${purpose}`
  if (!ended || afterWaits.has(key)) {
    return
  }
  afterWaits.add(key)
  void ended
    .then(() => {
      afterWaits.delete(key)
      return then()
    })
    .catch((error: unknown) => {
      console.warn('[orchestration] work after a worker start failed', key, error)
    })
}
