import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
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
          block.type === 'image-ref'
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
    body.kind === 'status' &&
    body.turnLifecycle &&
    body.turnLifecycle.state !== 'running' &&
    body.turnLifecycle.state !== 'completed'
  ) {
    normalized = fallback()
  }
  if (!isAdmissibleAgentJournalItemBody(normalized)) {
    throw new Error('agent_session_rewind:invalid-retained-body')
  }
  return normalized
}
