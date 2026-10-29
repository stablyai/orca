import { randomUUID } from 'node:crypto'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { ClaudeSession } from './structured/claude-structured-session-state'

/** Open the command turn before sending; its result settles the waiter and closes that turn. */
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
