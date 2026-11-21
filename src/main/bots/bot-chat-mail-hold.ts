/** Whether a bot's chat would hold another agent's mail instead of waking for it. */

import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { requireStructuredHost } from './bot-chat-session'

/** A chat whose last turn failed holds other agents' mail until its owner resumes or sends there, or
 *  automatic continue runs at a usage-limit reset; an unreadable chat is taken as not holding it. */
export async function chatHoldsAgentMail(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<boolean> {
  try {
    const host = await requireStructuredHost(runtime)
    return await (await host.conversation(sessionId)).journal.queuedMessages.failureHolds()
  } catch (error) {
    console.warn('[bots] could not read whether a chat holds mail', error)
    return false
  }
}
