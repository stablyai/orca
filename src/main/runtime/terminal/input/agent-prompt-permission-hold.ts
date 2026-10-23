/**
 * The agent-prompt writer's opt-in `onPermission: 'wait'`: hold a prompt while the agent asks for
 * permission instead of refusing it. The writer passes its own blocked predicate; this file owns
 * only when to re-read it and what ends the hold.
 */

/** A title- or screen-only answer moves no hook row, so the predicate is also re-read on a timer. */
export const AGENT_PROMPT_PERMISSION_RECHECK_MS = 1_000

/** The writer's pre-paste refusal under `wait`: no byte was written, so the hold may resume. */
export class AgentPromptPermissionReturnedError extends Error {
  constructor() {
    // The refusal's own message, so a leak reads as the refusal it stands for.
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

/**
 * Resolves once the predicate reads clear. Rejects on process exit, a throwing read, or abort. No
 * timeout: a lost SSH relay is none of those, so the hold survives it.
 */
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
