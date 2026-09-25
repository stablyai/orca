/**
 * An agent session named as a recipient: `session:<id>`, or a bare Orca session id. Any session on
 * this host can be addressed, not only one that coordinates a Run: an agent's id is its public
 * address, and a user telling one agent to message another's id is a supported workflow.
 *
 * Mail that no Run or Dispatch owns is stored at the conversation's `session:<root id>` and pointed
 * at its live session as a turn, so any session of a `/clear` lineage is a valid spelling. A
 * released lease is not a refusal (delivery resumes an evicted chat); a closed chat, another host,
 * and an unknown id are, before anything is stored.
 */

import {
  ORCA_SESSION_ADDRESS_PREFIX,
  formatOrcaSessionAddress,
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../../shared/orca-session-address'
// The caller codes, reused: each names the same fact about a session, whichever side of the mail it is on.
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../shared/orchestration-session-caller-codes'
import {
  lookupOrcaAgentSession,
  structuredSessionMailReach,
  type AgentSessionRecordReader
} from '../../../../orchestration/structured-session-mail-address'
import type { OrchestrationDb } from '../../../../orchestration/db'

/** `address` is the named session's own spelling; the mailbox mail lands in is its identity address. */
export type SessionRecipient = { sessionId: OrcaSessionId; address: OrcaSessionAddress }

export type SessionRecipientRefusal = {
  code: (typeof CODES)[keyof typeof CODES]
  message: string
}

/** Whether a recipient may name a session, so the caller can install the session host first. */
export function mayNameSession(recipient: string): boolean {
  return recipient.startsWith(ORCA_SESSION_ADDRESS_PREFIX) || isOrcaSessionId(recipient)
}

/**
 * The session a recipient names. A bare string names a session only when it is an Orca session id
 * this host has a record for; anything else stays a terminal handle, exactly as before.
 */
export function readSessionRecipient(
  recipient: string,
  store: AgentSessionRecordReader | null
): SessionRecipient | SessionRecipientRefusal | null {
  if (recipient.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    const sessionId = parseOrcaSessionAddress(recipient)
    return sessionId
      ? { sessionId, address: formatOrcaSessionAddress(sessionId) }
      : {
          code: CODES.unknown,
          message: `${recipient} does not name an Orca agent session id. No message was sent.`
        }
  }
  const sessionId = isOrcaSessionId(recipient) ? recipient : null
  const found = sessionId && store ? lookupOrcaAgentSession(store, sessionId) : null
  if (found?.kind === 'provider-id') {
    return providerIdRefusal(recipient, found.orcaSessionId)
  }
  return sessionId && found?.kind === 'found'
    ? { sessionId, address: formatOrcaSessionAddress(sessionId) }
    : null
}

/** Null when mail to this session can be stored and delivered here; otherwise why not. */
export function refuseUndeliverableSessionRecipient(
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  db: OrchestrationDb
): SessionRecipientRefusal | null {
  const { sessionId } = recipient
  if (!store) {
    return {
      code: CODES.unknown,
      message: `Agent session ${sessionId} cannot be verified: this Orca is not running its agent-session host. No message was sent.`
    }
  }
  const found = lookupOrcaAgentSession(store, sessionId)
  if (found.kind === 'provider-id') {
    return providerIdRefusal(sessionId, found.orcaSessionId)
  }
  if (found.kind === 'unknown') {
    return {
      code: CODES.unknown,
      message: `No Orca agent session ${sessionId} exists on this host. No message was sent.`
    }
  }
  const reach = structuredSessionMailReach(store, found.record, db)
  if (reach.kind === 'other-host') {
    return {
      code: CODES.hostBoundary,
      message: `Agent session ${sessionId} runs on another host; mail reaches a session only on the host that runs it. Send from that host. No message was sent.`
    }
  }
  if (reach.kind === 'ended') {
    return {
      code: CODES.notLive,
      message:
        reach.reason === 'continuation-missing'
          ? `Agent session ${sessionId} was cleared, and this host has no record of the session that continues it. No message was sent.`
          : reach.reason === 'worker-identity-lost'
            ? `Agent session ${sessionId} is a structured worker whose worker identity this host no longer has, so it can never read that mail. No message was sent.`
            : `Agent session ${sessionId} has ended: its chat was closed. No message was sent.`
    }
  }
  return null
}

function providerIdRefusal(id: string, orcaSessionId: string): SessionRecipientRefusal {
  return {
    code: CODES.providerId,
    message: `${id} is the provider's own session id, which changes on /clear. This session's Orca address is ${ORCA_SESSION_ADDRESS_PREFIX}${orcaSessionId}; use that instead. No message was sent.`
  }
}
