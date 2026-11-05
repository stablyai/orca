/** Opt-in permission holds re-read the writer's predicate until clear, exit or abort; the writer owns binding validity. */

/** A title- or screen-only answer moves no hook row, so the predicate is also re-read on a timer. */
export const AGENT_PROMPT_PERMISSION_RECHECK_MS = 1_000

/** The writer's pre-paste refusal under `wait`: no byte was written, so the hold may resume. */
export class AgentPromptPermissionReturnedError extends Error {
  constructor() {
    super('agent_prompt_blocked')
    this.name = 'AgentPromptPermissionReturnedError'
  }
}

export type AgentPromptPermissionHold = {
  /** The writer's predicate; throws when the write must not happen at all (binding changed). */
  isBlocked: () => boolean
  /** Hook-store changes for the pane; absent when the pane has no key. */
  subscribeStatus?: (wake: () => void) => () => void
  subscribeExit: (exited: () => void) => () => void
  signal?: AbortSignal
}

/** No timeout: lost SSH contact does not prove exit or end the hold. */
export function waitWhileAgentPromptBlocked(hold: AgentPromptPermissionHold): Promise<void> {
  return new Promise((resolve, reject) => {
    const releases: (() => void)[] = []
    let done = false
    const finish = (error?: Error): void => {
      if (done) {
        return
      }
      done = true
      releases.forEach((release) => release())
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const own = (release: () => void): void => {
      if (done) {
        release()
      } else {
        releases.push(release)
      }
    }
    const check = (): void => {
      if (done) {
        return
      }
      if (hold.signal?.aborted) {
        finish(new Error('request_aborted'))
        return
      }
      try {
        if (!hold.isBlocked()) {
          finish()
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('terminal_handle_stale'))
      }
    }
    // Subscribed before the first read, so an answer landing between them is not missed.
    if (hold.subscribeStatus) {
      own(hold.subscribeStatus(check))
    }
    own(hold.subscribeExit(() => finish(new Error('terminal_not_writable'))))
    if (hold.signal) {
      const signal = hold.signal
      const onAbort = (): void => finish(new Error('request_aborted'))
      signal.addEventListener('abort', onAbort)
      own(() => signal.removeEventListener('abort', onAbort))
    }
    check()
    if (!done) {
      const timer = setInterval(check, AGENT_PROMPT_PERMISSION_RECHECK_MS)
      own(() => clearInterval(timer))
    }
  })
}
