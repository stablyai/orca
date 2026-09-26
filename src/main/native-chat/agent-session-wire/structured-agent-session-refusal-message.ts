/**
 * Human-readable text for a lease refusal.
 *
 * A latched session is the one place a bare code is worst: the user is looking at a chat that will
 * not open, and `agent_session_ownership_unknown` tells them neither what Orca could not prove nor
 * what they can do about it. Every message here names the specific evidence that is missing and
 * the action that supplies it.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionRefusalCause,
  AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire'

function ownerDescription(record: AgentSessionRecord): string {
  const owner = record.lease.ownerProcess
  return owner ? `process ${owner.pid} on ${owner.hostId}` : 'a process it never got to record'
}

function latchedMessage(record: AgentSessionRecord): string {
  const owner = record.lease.ownerProcess
  if (record.lease.settlementRetryRequired) {
    return 'The provider exited, but Orca has not finished settling the terminal chat state. Reopen this chat to retry the settlement.'
  }
  if (record.lease.claimStatus === 'conflicted') {
    return owner
      ? `Two runtimes claimed this session and Orca cannot yet prove that ${ownerDescription(record)} has exited. Quit that process, or reopen this chat once it is gone, and Orca will take the session back.`
      : 'Two runtimes claimed this session and the record names no process to check. Quit any other Orca or agent process using this workspace, then reopen this chat.'
  }
  return owner
    ? `Orca cannot prove that ${ownerDescription(record)} — the previous owner of this session — has exited, so it will not start a second agent on the same conversation. Quit that process and reopen this chat.`
    : 'Orca cannot tell whether an agent started for this session before the app stopped, so it will not start a second one on the same conversation. Quit any leftover agent process for this workspace and reopen this chat.'
}

/**
 * A situation whose own words the store's code would get wrong: each of these reaches the chat as
 * `ownership_unknown` or `conflict`, which by code alone would read as the latched-owner story.
 */
const SITUATION_MESSAGES: Partial<Record<AgentSessionRefusalCause, string>> = {
  replaySuperseded: 'A newer start of this chat replaced this one. Try again.',
  leaseMoved: 'This chat changed hands while Orca was starting it. Try again.',
  spawnIdentityMismatch:
    'The agent that started was not the one Orca launched, so Orca did not use it. Try again.',
  identityMismatch:
    'This chat belongs to a different workspace, agent or account. Start a new chat to continue.',
  sessionExists: 'This chat already exists. Open it to continue.',
  tabIdTaken: 'Another chat already uses this tab. Try again.',
  conversationHeldElsewhere:
    'Another chat is already working in this conversation. Open that chat to continue.',
  // Also a damaged record, which no update opens.
  recordUnreadable:
    "Orca can't read this chat's saved state. If a newer version of Orca saved it, update Orca to open it; otherwise start a new chat."
}

/**
 * The words and the situation for a store refusal. `cause` is what the emitter named, when it named
 * one; the latched branches name their own. Null when neither has a story to tell, and the caller
 * keeps its own wording.
 */
export function structuredAgentSessionRefusalMessage(
  code: AgentSessionWireRefusalCode,
  cause: AgentSessionRefusalCause | undefined,
  record: AgentSessionRecord | null
): { message: string; cause: AgentSessionRefusalCause } | null {
  const situational = cause ? SITUATION_MESSAGES[cause] : undefined
  if (cause && situational) {
    return { message: situational, cause }
  }
  if (!record) {
    return null
  }
  if (code === 'agent_session_ownership_unknown' || code === 'agent_session_conflict') {
    return latchedRefusal(record, cause)
  }
  if (code === 'execution_owner_reconciling') {
    return {
      message:
        'Orca is still working out who owns this session on this machine. Reopen the chat in a moment.',
      cause: 'hostReconciling'
    }
  }
  return null
}

function latchedRefusal(
  record: AgentSessionRecord,
  cause: AgentSessionRefusalCause | undefined
): { message: string; cause: AgentSessionRefusalCause } {
  const message = latchedMessage(record)
  if (record.lease.settlementRetryRequired) {
    return { message, cause: 'settlementPending' }
  }
  if (record.lease.claimStatus === 'conflicted') {
    return { message, cause: 'claimConflicted' }
  }
  return { message, cause: cause === 'ownerAlive' ? 'ownerAlive' : 'ownerUnproven' }
}
