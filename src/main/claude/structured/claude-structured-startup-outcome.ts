import { startupAcquisitionRefusal } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'

/** One acquisition's startup: a failure Claude reports before open succeeds fails that open. */
export type ClaudeStartupOutcome = {
  /** Takes a startup failure only while this start will report it; a start already failed or stopped keeps its own report. */
  accept: (error: Error) => boolean
  /** Another route (initialize, transport, exit) failed this start, so it reports that cause, not a later result; an exit calls it before buffered results drain. */
  fail: (error: unknown) => void
  /** Settles with `work`, or rejects as soon as a startup failure is accepted. */
  race: <T>(work: Promise<T>) => Promise<T>
  /** Throws an accepted failure; otherwise later failures belong to the journal for good. */
  open: () => void
}

export function createClaudeStartupOutcome(): ClaudeStartupOutcome {
  let state: 'pending' | 'opened' | { accepted: Error } | { failed: unknown } = 'pending'
  let rejectFailed = (_error: Error): void => {}
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject
  })
  void failed.catch(() => {})
  return {
    accept: (error) => {
      if (state === 'pending') {
        state = { accepted: error }
        rejectFailed(error)
        return true
      }
      if (state === 'opened') {
        return false
      }
      if ('accepted' in state) {
        return true
      }
      // The failure that ended this start already carries the same refusal and Claude's text.
      const reason = startupAcquisitionRefusal(error)?.reason
      return reason !== undefined && startupAcquisitionRefusal(state.failed)?.reason === reason
    },
    fail: (error) => {
      if (state === 'pending') {
        state = { failed: error }
      }
    },
    race: (work) => Promise.race([work, failed]),
    open: () => {
      if (typeof state === 'object' && 'accepted' in state) {
        throw state.accepted
      }
      state = 'opened'
    }
  }
}
