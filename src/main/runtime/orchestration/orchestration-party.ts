// The one place an orchestration address becomes a party, so no two sites can disagree on who it names.
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  isRecordedStructuredWorkerSession,
  resolveStructuredWorkerIdentity,
  resolveStructuredWorkerIdentityForSession
} from '../structured-worker-authority'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import type { OrchestrationDb } from './db'
import { mailboxAddressOf, type OrchestrationCallerIdentity } from './orchestration-caller-identity'
import { OrchestrationError } from './orchestration-error'

/** A party as Run binding and mail routing match it; `address` is its one mailbox address. */
export type OrchestrationParty = OrchestrationCallerIdentity

/** A party named by an Orca session id: a structured worker, or a chat. */
export type OrchestrationSessionParty = OrchestrationParty &
  Readonly<{ orcaSessionId: OrcaSessionId }>

const NO_EFFECTS = { effectsApplied: false } as const

/** Every param naming a party other than the caller; a new one is added here with its own test. */
export const ORCHESTRATION_TARGET_PARAM: Readonly<Record<string, 'to' | 'terminal'>> = {
  'orchestration.send': 'to',
  'orchestration.ask': 'to',
  'orchestration.dispatch': 'to',
  'orchestration.inbox': 'terminal'
}

/** The party an Orca session id names. Throws when it is a worker this host lost the identity of. */
export function resolveOrcaSessionParty(
  orcaSessionId: OrcaSessionId,
  db: OrchestrationDb | null | undefined
): OrchestrationSessionParty {
  const id = canonicalOrcaSessionId(orcaSessionId)
  const worker = resolveStructuredWorkerIdentityForSession(id, db)
  if (!worker && db && isRecordedStructuredWorkerSession(id, db)) {
    // Why: handle-less, it would split one worker into two parties and bind like a chat.
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${id} is a structured worker whose worker identity this host no longer has, so orchestration cannot address it. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const key = { terminalHandle: worker?.handle ?? null, orcaSessionId: id }
  return {
    ...key,
    address: mailboxAddressOf(key) ?? formatOrcaSessionAddress(id),
    paneKey: worker?.paneKey ?? null
  }
}

/** The party an address names; a PTY handle is itself and costs no lookup. */
export function resolveOrchestrationParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const orcaSessionId = parseOrcaSessionAddress(address)
  if (orcaSessionId) {
    return resolveOrcaSessionParty(orcaSessionId, db)
  }
  const worker = resolveStructuredWorkerIdentity(address, db)
  return {
    address,
    terminalHandle: address,
    paneKey: worker?.paneKey ?? null,
    orcaSessionId:
      worker && isOrcaSessionId(worker.sessionId) ? canonicalOrcaSessionId(worker.sessionId) : null
  }
}

/** A caller named by a param: naming a chat's address proves nothing, unlike its own session id. */
export function resolveDeclaredCallerParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const party = resolveOrchestrationParty(address, db)
  if (party.terminalHandle === null) {
    throw new OrchestrationError(
      CODES.chatNotDeclarable,
      `Agent session ${party.orcaSessionId} is a chat, and a chat is identified only by the session id its own environment sends, never by naming its address. No effects were applied.`,
      NO_EFFECTS
    )
  }
  return party
}

/** A Dispatch assignee: a terminal or a structured worker, never a chat yet. */
export function resolveDispatchAssigneeParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const party = resolveOrchestrationParty(address, db)
  if (party.terminalHandle === null) {
    throw new OrchestrationError(
      CODES.chatNotDispatchable,
      `Agent session ${party.orcaSessionId} is a chat, and a chat can't receive a dispatch yet. Start a worker with worker-start instead. No effects were applied.`,
      NO_EFFECTS
    )
  }
  return party
}
