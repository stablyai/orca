// Convert the entire pre-attach span to coded no-effects refusal, including code-less failures such as unresolved workspace/store/host.
// Transport-like throws cannot distinguish those failures from lost answers and invite stranded or duplicate chats.

import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  refuseUnclassified,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { isAgentSessionCreateAdmissionRefusal } from '../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'

export type StructuredCreateRefused = { refusal: AgentSessionWireRefusal }

/** Code-less pre-commit failure maps to the existing unsupported refusal; older clients would not understand a more specific new code. */
const UNCODED_PRECOMMIT_REFUSAL_CODE: AgentSessionWireRefusalCode =
  'structured_agent_session_unsupported'

function wireRefusalCode(error: unknown): AgentSessionWireRefusalCode | null {
  const candidates = [
    error instanceof Error && 'code' in error ? (error as { code: unknown }).code : undefined,
    error instanceof Error ? error.message : String(error)
  ]
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(candidate)
    ) {
      return candidate as AgentSessionWireRefusalCode
    }
  }
  return null
}

const PRECOMMIT_REFUSAL_MESSAGE = 'Orca cannot open a structured agent chat for this workspace.'

function precommitRefusal(error: unknown, agent?: string): AgentSessionWireRefusal {
  // A refusal the host raised keeps its situation; a bare code names none.
  if (isAgentSessionRefusalError(error)) {
    return agentSessionRefusalFromReference(error.refusal, PRECOMMIT_REFUSAL_MESSAGE)
  }
  const code = wireRefusalCode(error)
  if (code) {
    return refuseUnclassified(code, PRECOMMIT_REFUSAL_MESSAGE)
  }
  // Log code-less faults while returning compatibility refusal; no structured situation means no reason field.
  console.warn('[agent-session] create refused before it committed anything', error)
  const agentName = agent ? tuiAgentDisplayName(agent) : null
  return refuseUnclassified(
    UNCODED_PRECOMMIT_REFUSAL_CODE,
    agentName
      ? `${agentName} chat could not be started. Try again.`
      : 'The chat could not be started. Try again.'
  )
}

/** Convert throws only before attach; afterward failure cannot prove no session exists. Preserve explicit refusals unchanged. */
export async function resolveUncommittedStructuredCreate<TPrepared>(
  prepare: () => Promise<TPrepared | StructuredCreateRefused>,
  agent?: string
): Promise<TPrepared | StructuredCreateRefused> {
  try {
    return await prepare()
  } catch (error) {
    const refusal = precommitRefusal(error, agent)
    return {
      refusal: isAgentSessionCreateAdmissionRefusal(refusal)
        ? { ...refusal, createAttemptRefusedBeforeCommit: true }
        : refusal
    }
  }
}
