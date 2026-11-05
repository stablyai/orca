/** Private reconstruction may pause; a published model is adopted only after it is complete. */
export function finishJournalSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) {
      return next.value
    }
  }
}

export async function finishJournalStepsAsync<T>(
  steps: Generator<void, T>,
  scope: (next: () => IteratorResult<void, T>) => IteratorResult<void, T> = (next) => next()
): Promise<T> {
  let work = 0
  for (;;) {
    const next = scope(() => steps.next())
    if (next.done) {
      return next.value
    }
    if (++work === 256) {
      work = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

export { sortAgentSessionSteps as sortJournalSteps } from '../../../shared/agent-session/agent-session-projection-steps'
