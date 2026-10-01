import { randomUUID } from 'node:crypto'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'

/** Sent like any message, so the slash-command waiter settles it on its result. The translator
 *  makes the command's turn the open one before the send, and that same result ends it. */
export async function dispatchClaudeCommand(
  session: ClaudeSession,
  command: StructuredAgentSessionCommandRun
): Promise<AgentSessionCommandAdmission> {
  const sentUuid = randomUUID()
  session.translator?.beginCommand({
    ...command,
    providerSessionId: session.providerSessionId,
    sentUuid
  })
  try {
    const admission = await dispatchClaudeTurn(session, {
      clientMessageId: command.clientMessageId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '/compact' }] },
      ...(command.running.requestedAt === undefined
        ? {}
        : { requestedAt: command.running.requestedAt }),
      sentUuid
    })
    if (admission.state === 'rejected') {
      session.translator?.forgetCommand(command.turnId)
    }
    return admission
  } catch (error) {
    session.translator?.forgetCommand(command.turnId)
    throw error
  }
}
