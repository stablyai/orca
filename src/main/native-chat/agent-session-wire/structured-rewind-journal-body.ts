import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import {
  AGENT_JOURNAL_TURN_LIFECYCLE_STATES,
  AGENT_JOURNAL_TURN_OUTCOMES,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import { NATIVE_CHAT_ROLES } from '../../../shared/native-chat-types'

type StoredBody = AgentSessionRewindRecord['retained'][number]['body']

/** Unknown future values remain visible evidence, never invented turn or prompt state. */
export function restoreRewindJournalBody(body: StoredBody): AgentJournalItemBody {
  let normalized: unknown = body
  const fallback = () => ({ kind: 'status', text: JSON.stringify(body) })
  if (body.kind === 'message') {
    normalized = {
      ...body,
      role: NATIVE_CHAT_ROLES.find((role) => role === body.role) ?? 'system',
      blocks: body.blocks.map((block) => {
        if (
          (block.type === 'text' && 'text' in block) ||
          (block.type === 'tool-call' && 'name' in block && !('state' in block)) ||
          (block.type === 'tool-result' && 'output' in block) ||
          block.type === 'image-ref' ||
          (block.type === 'background-task' &&
            'taskId' in block &&
            'kind' in block &&
            'label' in block &&
            'state' in block)
        ) {
          return block
        }
        if (
          block.type === 'tool-call' &&
          'state' in block &&
          (block.state === 'running' || block.state === 'completed' || block.state === 'failed')
        ) {
          return block
        }
        return { type: 'text', text: JSON.stringify(block) }
      })
    }
  } else if (
    body.kind === 'tool-call' &&
    body.state !== 'running' &&
    body.state !== 'completed' &&
    body.state !== 'failed'
  ) {
    normalized = fallback()
  } else if (
    (body.kind === 'approval' || body.kind === 'question') &&
    body.resolution.state !== 'pending' &&
    body.resolution.state !== 'resolved' &&
    body.resolution.state !== 'cancelled'
  ) {
    normalized = fallback()
  } else if (
    (body.kind === 'turn' || (body.kind === 'status' && body.turnLifecycle)) &&
    !(AGENT_JOURNAL_TURN_LIFECYCLE_STATES as readonly string[]).includes(
      body.kind === 'turn' ? body.state : body.turnLifecycle!.state
    )
  ) {
    normalized = fallback()
  } else if (body.kind === 'turn' || (body.kind === 'status' && body.turnLifecycle)) {
    normalized = withKnownTurnOutcome(body)
  }
  if (!isAdmissibleAgentJournalItemBody(normalized)) {
    throw new Error('agent_session_rewind:invalid-retained-body')
  }
  return normalized
}

/** A verdict from a later vocabulary is dropped, never coerced and never fatal.
 *  Unlike an unknown `state`, an unplaceable outcome costs nothing to discard —
 *  absent already means unknown — and discarding it keeps the turn's endpoints,
 *  which a status fallback would throw away along with the timing every surface
 *  reads. */
function withKnownTurnOutcome(
  body: Extract<StoredBody, { kind: 'turn' } | { kind: 'status' }>
): StoredBody {
  const known = (outcome: string | undefined): boolean =>
    outcome === undefined || AGENT_JOURNAL_TURN_OUTCOMES.some((arm) => arm === outcome)
  if (body.kind === 'turn') {
    if (known(body.outcome)) {
      return body
    }
    const { outcome: _outcome, ...rest } = body
    return rest
  }
  const lifecycle = body.turnLifecycle
  if (!lifecycle || known(lifecycle.outcome)) {
    return body
  }
  const { outcome: _outcome, ...rest } = lifecycle
  return { ...body, turnLifecycle: rest }
}
