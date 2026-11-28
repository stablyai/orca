/** Address any host-local chat by Orca session id, including /clear ancestors.
 * Unbound mail belongs to the root mailbox and points at the live session. Released leases may restart; closed/foreign/unknown chats refuse before storage. */

import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/agent-session/identity/orca-session-address-prefix'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../shared/orchestration/orchestration-session-caller-codes'
import {
  lookupOrcaAgentSession,
  structuredSessionMailReach,
  structuredSessionMailReachWith,
  type StructuredSessionMailReach,
  type StructuredSessionReachContext
} from '../../../../orchestration/mailbox/routing/structured-session-mail-address'
import {
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../../../../orchestration/addressing/session-lineage/structured-session-lineage'
import type { AgentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { agentHookServer } from '../../../../../agent-hooks/server/agent-hook-server'

/** `address` is the named session's own spelling; the mailbox mail lands in is its identity address. */
export type SessionRecipient = { sessionId: OrcaSessionId; address: OrcaSessionAddress }

/** Why a known chat takes no mail, as a picker words it: closed, run elsewhere, or not checkable. */
export type SessionRecipientUnreachable = 'ended' | 'other-host' | 'unverifiable'

export type SessionRecipientRefusal = {
  code: (typeof CODES)[keyof typeof CODES] | 'recipient_unreachable'
  message: string
  /** Set by the reach check alone, so a chat list can say why without parsing the message. */
  unreachable?: SessionRecipientUnreachable
}

/** Whether a recipient may name a session, so the caller can install the session host first. */
export function mayNameSession(recipient: string): boolean {
  return recipient.startsWith(ORCA_SESSION_ADDRESS_PREFIX) || isOrcaSessionId(recipient)
}

/** A recipient that names one of this host's terminal agents, and where it runs now. */
export type TerminalAgentRecipient = {
  sessionId: string
  places: { paneKey: string; worktreeId?: string }[]
} | null

/** Resolved before routing: a dormant terminal id is known only to the identity store, which
 *  answers asynchronously. A known chat (or its provider id) is decided by the chat store alone,
 *  so chat mail never waits on the identity worker. Callers reread the facts they act on after
 *  awaiting this. */
export async function resolveTerminalAgentRecipient(
  recipient: string
): Promise<TerminalAgentRecipient> {
  const sessionId = recipient.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
    ? parseOrcaSessionAddress(recipient)
    : isOrcaSessionId(recipient)
      ? recipient
      : null
  const store = sessionId ? readAgentSessionRecordStore() : null
  if (!sessionId || (store && lookupOrcaAgentSession(store, sessionId).kind !== 'unknown')) {
    return null
  }
  const places = await agentHookServer.terminalAgentPlaces(sessionId)
  return places ? { sessionId, places } : null
}

/** Before routing a session-shaped recipient: opens the chat store, resolves a terminal agent,
 *  then checks the caller's authority again, since the waits may have outlived it. */
export async function prepareSessionRecipient(
  runtime: { ensureStructuredAgentSessionHost(): Promise<unknown> },
  recipient: string,
  revalidateCaller?: () => unknown
): Promise<TerminalAgentRecipient> {
  if (!mayNameSession(recipient)) {
    return null
  }
  // Recipient routing reads the session record store, which the host opens lazily.
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const terminal = await resolveTerminalAgentRecipient(recipient)
  revalidateCaller?.()
  return terminal
}

/** Recognize bare ids as sessions only when a local record exists; preserve terminal-handle interpretation otherwise. */
export function readSessionRecipient(
  recipient: string,
  store: AgentSessionRecordReader | null,
  terminalRecipient: TerminalAgentRecipient
): SessionRecipient | SessionRecipientRefusal | null {
  if (recipient.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    const sessionId = parseOrcaSessionAddress(recipient)
    return sessionId
      ? { sessionId, address: formatOrcaSessionAddress(sessionId) }
      : {
          code: CODES.unknown,
          message: `${recipient} does not name an Orca session ID. No message was sent.`
        }
  }
  const sessionId = isOrcaSessionId(recipient) ? recipient : null
  const found = sessionId && store ? lookupOrcaAgentSession(store, sessionId) : null
  if (found?.kind === 'provider-id') {
    return providerIdRefusal(recipient, found.orcaSessionId, store)
  }
  if (sessionId && found?.kind !== 'found') {
    const terminal = terminalAgentRefusal(sessionId, terminalRecipient)
    if (terminal) {
      return terminal
    }
  }
  return sessionId && found?.kind === 'found'
    ? { sessionId, address: formatOrcaSessionAddress(sessionId) }
    : null
}

/** Share mail/task reachability: null admits storage/delivery here, otherwise return the refusal. */
export function refuseUndeliverableSessionRecipient(
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  db: OrchestrationDb,
  terminalRecipient: TerminalAgentRecipient,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal | null {
  const result = resolveSessionRecipient(recipient, store, db, terminalRecipient, noEffect)
  return 'session' in result ? null : result
}

type SessionRecipientReach =
  | Extract<StructuredSessionMailReach, { kind: 'reachable' }>
  | SessionRecipientRefusal

export function resolveSessionRecipient(
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  db: OrchestrationDb,
  terminalRecipient: TerminalAgentRecipient,
  noEffect: string
): SessionRecipientReach {
  // Before the host check: terminal-only users have no agent-session host to blame.
  const terminal = terminalAgentRefusal(recipient.sessionId, terminalRecipient, noEffect)
  if (terminal) {
    return terminal
  }
  return resolveSessionRecipientReach(
    recipient,
    store,
    (records, found) => structuredSessionMailReach(records, found, db),
    noEffect
  )
}

/** The same refusal, with lineage walks and party resolutions shared across one pass over many chats. */
export function refuseUndeliverableSessionRecipientWith(
  context: StructuredSessionReachContext,
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal | null {
  const result = resolveSessionRecipientReach(
    recipient,
    store,
    (records, found) => structuredSessionMailReachWith(context, records, found),
    noEffect
  )
  return 'session' in result ? null : result
}

function resolveSessionRecipientReach(
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  reach: (
    records: AgentSessionRecordReader,
    found: AgentSessionConversationView
  ) => StructuredSessionMailReach,
  noEffect: string
): SessionRecipientReach {
  const { sessionId } = recipient
  if (!store) {
    return {
      code: CODES.unknown,
      message: `Agent session ${sessionId} cannot be verified: this Orca is not running its agent-session host. ${noEffect}`,
      unreachable: 'unverifiable'
    }
  }
  const found = lookupOrcaAgentSession(store, sessionId)
  if (found.kind === 'provider-id') {
    return providerIdRefusal(sessionId, found.orcaSessionId, store, noEffect)
  }
  if (found.kind === 'unknown') {
    return {
      code: CODES.unknown,
      message: `No Orca agent session ${sessionId} exists on this host. ${noEffect}`,
      unreachable: 'unverifiable'
    }
  }
  const reached = reach(store, found.record)
  if (reached.kind === 'other-host') {
    return {
      code: CODES.hostBoundary,
      message: `Agent session ${sessionId} runs on another host; mail reaches a session only on the host that runs it. Send from that host. ${noEffect}`,
      unreachable: 'other-host'
    }
  }
  if (reached.kind === 'unverifiable') {
    return {
      code: 'recipient_unreachable',
      message: `Orca could not verify the chat continuing the requested session ${sessionId} after /clear. ${reached.reason} ${noEffect}`,
      unreachable: 'unverifiable'
    }
  }
  if (reached.kind === 'ended') {
    return reached.reason === 'worker-identity-lost'
      ? {
          code: CODES.notLive,
          message: `Agent session ${sessionId} is a structured worker whose worker identity this host no longer has. ${noEffect}`,
          unreachable: 'unverifiable'
        }
      : {
          code: 'recipient_unreachable',
          message: `The requested chat ${sessionId} is closed. ${noEffect}`,
          unreachable: 'ended'
        }
  }
  return reached
}

function providerIdRefusal(
  id: string,
  orcaSessionId: string,
  store: AgentSessionRecordReader | null,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal {
  // The conversation's Orca session ID, which a `/clear`ed session keeps; not the live session's.
  const root = isOrcaSessionId(orcaSessionId)
    ? canonicalOrcaSessionId(orcaSessionId, store)
    : orcaSessionId
  const address = `${ORCA_SESSION_ADDRESS_PREFIX}${root}`
  return {
    code: CODES.providerId,
    message: `${id} is the provider's own session id, which changes on /clear. This session's Orca session ID is ${address}; address it by that instead. ${noEffect}`
  }
}

/** Terminal agents have Orca ids, but mail reaches them only through their terminal for now. */
function terminalAgentRefusal(
  sessionId: OrcaSessionId,
  terminalRecipient: TerminalAgentRecipient,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal | null {
  if (terminalRecipient?.sessionId !== sessionId) {
    return null
  }
  const places = terminalRecipient.places.map((place) =>
    place.worktreeId
      ? `pane ${place.paneKey} in workspace ${place.worktreeId}`
      : `pane ${place.paneKey}`
  )
  const where = places.length > 0 ? `, running in ${places.join('; ')}` : ''
  return {
    code: CODES.terminalAgent,
    message: `Agent ${sessionId} is a terminal agent${where}. Messaging terminal agents by ID isn't supported yet; address its terminal instead. ${noEffect}`
  }
}
