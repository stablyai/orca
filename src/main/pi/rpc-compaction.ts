import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { PiRpcSession } from './rpc-session'

export async function compactPiRpcSession(
  session: PiRpcSession,
  command: StructuredAgentSessionCommandRun
): Promise<AgentSessionCommandAdmission> {
  session.turns.beginCommand(command)
  try {
    await session.connection.request('compact', {}, { timeoutMs: null })
    session.turns.commandCompleted()
    return { state: 'accepted', providerIdentity: null }
  } catch (error) {
    if (!(error instanceof JsonlRpcResponseError)) {
      throw error
    }
    if (error.message === 'Nothing to compact (session too small)') {
      session.lane.apply([
        {
          type: 'item.close',
          item: `compact-noop:${command.turnId}`,
          body: { kind: 'status', tone: 'warning', text: error.message }
        }
      ])
      session.turns.commandCompleted()
      return { state: 'accepted', providerIdentity: null }
    }
    session.turns.commandRejected()
    return {
      state: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('providerRejected', {
          detail: providerDiagnostic(error.message, 'person')
        }),
        { agentName: 'Pi', surface: 'rejection' }
      )
    }
  }
}
