import { claudeUnwrittenUserMessageError } from '../sdk-transport/claude-agent-sdk-user-message-queue'
import { ClaudeControlRequestError } from '../sdk-transport/claude-agent-sdk-control-requests'

/**
 * What a chat may still ask of a Claude agent that kept running while Orca was closed: new
 * messages, Stop, and settings changes. Every caller reaches a kept agent only through this.
 */
export type ClaudeKeptAgentInput = {
  send: (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Stop. */
  interrupt: () => Promise<undefined>
  control: <T>(subtype: string) => Promise<T>
}

const STILL_FINISHING = "This chat's agent is still finishing the work it started before Orca restarted."

/**
 * The kept agent finishes the work it already has; a new message is refused (never written), Stop
 * ends the agent, and settings wait until it has ended and the next message cold-resumes.
 */
export function claudeKeptAgentFinishingInput(end: () => Promise<unknown>): ClaudeKeptAgentInput {
  return {
    send: () => Promise.reject(claudeUnwrittenUserMessageError(new Error(STILL_FINISHING))),
    interrupt: async () => {
      await end()
      return undefined
    },
    control: (subtype) => Promise.reject(new ClaudeControlRequestError(subtype, STILL_FINISHING))
  }
}
