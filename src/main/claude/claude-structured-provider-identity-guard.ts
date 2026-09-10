import { readClaudeFrameString } from './claude-structured-init-proof'
import type { ClaudeAcquisitionAttempt } from './claude-structured-session-state'

export type ClaudeProviderIdentityGuard = {
  /** Whether this frame belongs to the provider session the acquisition owns. */
  admits: (message: Record<string, unknown>, isInit: boolean) => boolean
  /** The first foreign identity observed, at any point in the acquisition's life. */
  readonly refused: Error | null
}

/**
 * Which provider session an acquisition is allowed to hear from.
 *
 * A resume proves its identity against the init observation it waits for. A fork cannot: it
 * publishes the session id it ASKED the CLI for (`--session-id`), no reply confirms that id, and
 * the CLI only names a session on a transcript frame — which a fork does not produce until its
 * first real prompt. So for a fork this filter IS the identity proof, and it therefore has to hold
 * for the life of the session rather than only until the init deadline is cleared.
 *
 * Frames from another session stay quarantined silently, as before. An init frame naming another
 * session does not: quarantining that one in silence leaves a chat that looks alive and can never
 * receive anything again, so it fails the acquisition, or ends an already published session.
 */
export function createClaudeProviderIdentityGuard(input: {
  sessionId: string
  /** Read late: the expected id is only known once the launch resolves. */
  expected: () => string | null
  attempt: ClaudeAcquisitionAttempt
  /** Fails a still-awaited init deadline promptly. */
  rejectInit: (error: Error) => void
  /** Terminal path once frames are being delivered: close the child and publish its lifecycle. */
  endSession: (error: Error) => void
}): ClaudeProviderIdentityGuard {
  let refused: Error | null = null
  return {
    get refused(): Error | null {
      return refused
    },
    admits: (message, isInit) => {
      const named = readClaudeFrameString(message, 'session_id')
      if (named === input.expected()) {
        return true
      }
      if (isInit || (message.type === 'system' && message.subtype === 'init')) {
        refused ??= new Error(
          `claude named provider session ${named ?? '<unnamed>'} for session ${input.sessionId}, expected ${input.expected() ?? '<unresolved>'}`
        )
        if (input.attempt.published) {
          input.endSession(refused)
        } else {
          input.rejectInit(refused)
        }
      }
      return false
    }
  }
}
