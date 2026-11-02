/** One acquisition's startup: a failure Claude reports before open succeeds fails that open. */
export type ClaudeStartupOutcome = {
  /** Takes a startup failure until open succeeds, keeping the first; a start already failed or stopped keeps its own report. */
  accept: (error: Error) => boolean
  /** Settles with `work`, or rejects as soon as a startup failure is accepted. */
  race: <T>(work: Promise<T>) => Promise<T>
  /** Throws an accepted failure; otherwise later failures belong to the journal for good. */
  open: () => void
}

export function createClaudeStartupOutcome(): ClaudeStartupOutcome {
  let state: 'pending' | 'opened' | { error: Error } = 'pending'
  let rejectFailed = (_error: Error): void => {}
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject
  })
  void failed.catch(() => {})
  return {
    accept: (error) => {
      if (state === 'opened') {
        return false
      }
      if (state === 'pending') {
        state = { error }
        rejectFailed(error)
      }
      return true
    },
    race: (work) => Promise.race([work, failed]),
    open: () => {
      if (typeof state === 'object') {
        throw state.error
      }
      state = 'opened'
    }
  }
}
