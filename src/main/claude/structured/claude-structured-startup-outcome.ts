import { startupAcquisitionRefusal } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'

/** One acquisition's startup: its first ending cause is the one its open rejects with. */
export type ClaudeStartupOutcome = {
  /** Takes a startup failure only while this start will report it; a start already failed or stopped keeps its own report. */
  accept: (error: Error) => boolean
  /** Ends this start with `error` unless it already ended, and returns the cause its open rejects with. */
  fail: (error: unknown) => unknown
  /** Settles with `work`, or rejects as soon as this start ends; `work`'s own rejection ends it unless stopped. */
  race: <T>(work: Promise<T>, signal: AbortSignal) => Promise<T>
  /** Throws the cause that ended this start; otherwise later failures belong to the journal for good. */
  open: () => void
  /** Whether the whole host-awaited open has returned for this start. */
  opened: () => boolean
}

export function createClaudeStartupOutcome(): ClaudeStartupOutcome {
  let state: 'pending' | 'opened' | { accepted: Error } | { failed: unknown } = 'pending'
  let rejectFailed = (_error: unknown): void => {}
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject
  })
  void failed.catch(() => {})
  const ended = (): unknown =>
    typeof state !== 'object' ? undefined : 'accepted' in state ? state.accepted : state.failed
  const fail = (error: unknown): unknown => {
    if (state === 'pending') {
      state = { failed: error }
      rejectFailed(error)
    }
    return ended() ?? error
  }
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
    fail,
    race: (work, signal) => {
      // Registered before the race's own handler, so no result is taken once `work` has failed.
      work.then(undefined, (error: unknown) => {
        if (!signal.aborted) {
          fail(error)
        }
      })
      return Promise.race([work, failed])
    },
    open: () => {
      if (state !== 'pending' && state !== 'opened') {
        throw ended()
      }
      state = 'opened'
    },
    opened: () => state === 'opened'
  }
}
