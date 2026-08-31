import { readClaudeFrameString } from './claude-structured-init-proof'
import type { ClaudeSession } from './claude-structured-session-state'

const NONTERMINAL_COMMAND_STATES = new Set(['queued', 'started'])
const TERMINAL_COMMAND_STATES = new Set(['completed', 'cancelled', 'discarded'])

export class ClaudeRetiredSentUserUuids {
  private readonly bySession = new Map<string, Set<string>>()

  has(sessionId: string, uuid: string): boolean {
    return this.bySession.get(sessionId)?.has(uuid) === true
  }

  retire(sessionId: string, session: ClaudeSession): void {
    if (session.sentUserUuidSequence.size === 0) {
      return
    }
    const retired = this.bySession.get(sessionId) ?? new Set<string>()
    for (const uuid of session.sentUserUuidSequence.keys()) {
      retired.add(uuid)
    }
    this.bySession.set(sessionId, retired)
  }
}

function ownedClaudeUserTurnSequence(
  session: ClaudeSession,
  message: Record<string, unknown>,
  uuid: string | null
): number | undefined {
  if (
    !uuid ||
    message.type !== 'user' ||
    message.parent_tool_use_id !== null ||
    readClaudeFrameString(message, 'session_id') !== session.providerSessionId
  ) {
    return undefined
  }
  return session.sentUserUuidSequence.get(uuid)
}

function handleClaudeOwnedReceipt(session: ClaudeSession, message: Record<string, unknown>): void {
  if (readClaudeFrameString(message, 'session_id') !== session.providerSessionId) {
    return
  }
  if (message.type === 'command_lifecycle') {
    const turnId = readClaudeFrameString(message, 'command_uuid')
    const state = readClaudeFrameString(message, 'state')
    if (!turnId || !state || !session.sentUserUuidSequence.has(turnId)) {
      return
    }
    if (NONTERMINAL_COMMAND_STATES.has(state)) {
      session.deliveryEvidenceUuids.add(turnId)
      session.translator?.confirmOwnedTurn(turnId)
    } else if (TERMINAL_COMMAND_STATES.has(state)) {
      session.deliveryEvidenceUuids.add(turnId)
      session.translator?.settleOwnedTurn(turnId)
    }
    return
  }
  if (message.type !== 'result') {
    return
  }
  const turnId = readClaudeFrameString(message, 'user_message_uuid')
  if (!turnId || !session.sentUserUuidSequence.has(turnId)) {
    return
  }
  session.deliveryEvidenceUuids.add(turnId)
  session.translator?.settleOwnedTurn(turnId)
}

export function applyClaudeSessionMessageIdentity(input: {
  session: ClaudeSession
  message: Record<string, unknown>
  uuid: string | null
  retiredOwnedUuid: boolean
}): boolean {
  const { session, message, uuid, retiredOwnedUuid } = input
  if (
    !retiredOwnedUuid &&
    readClaudeFrameString(message, 'session_id') === session.providerSessionId
  ) {
    session.leafUuid = uuid ?? session.leafUuid
  }
  const sequence = retiredOwnedUuid
    ? undefined
    : ownedClaudeUserTurnSequence(session, message, uuid)
  if (uuid && sequence !== undefined) {
    session.deliveryEvidenceUuids.add(uuid)
    session.translator?.confirmOwnedTurn(uuid)
    return false
  }
  if (!retiredOwnedUuid) {
    handleClaudeOwnedReceipt(session, message)
  }
  return true
}
