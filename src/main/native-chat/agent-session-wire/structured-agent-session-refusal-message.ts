/**
 * Human-readable text for a lease refusal.
 *
 * A latched session is the one place a bare code is worst: the user is looking at a chat that will
 * not open, and `agent_session_ownership_unknown` tells them neither what Orca could not prove nor
 * what they can do about it. Every message here names the specific evidence that is missing and
 * the action that supplies it.
 */

import { terminalOwnerRefusalMessage } from '../../../shared/agent-session-legacy-handoff-lease'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusalCode } from '../../../shared/agent-session-wire'

function ownerDescription(record: AgentSessionRecord): string {
  const owner = record.lease.ownerProcess
  return owner ? `process ${owner.pid} on ${owner.hostId}` : 'a process it never got to record'
}

function latchedMessage(record: AgentSessionRecord): string {
  if (record.lease.claimStatus === 'conflicted') {
    return terminalOwnerRefusalMessage(record.lease)
  }
  return record.lease.ownerProcess
    ? `Orca cannot prove that ${ownerDescription(record)} — the previous owner of this session — has exited, so it will not start a second agent on the same conversation. Quit that process and reopen this chat.`
    : 'Orca cannot tell whether an agent started for this session before the app stopped, so it will not start a second one on the same conversation. Quit any leftover agent process for this workspace and reopen this chat.'
}

/** Null when the code has no session-specific story to tell; the caller keeps its own wording. */
export function structuredAgentSessionRefusalMessage(
  code: AgentSessionWireRefusalCode,
  record: AgentSessionRecord | null
): string | null {
  if (!record) {
    return null
  }
  if (code === 'agent_session_ownership_unknown' || code === 'agent_session_conflict') {
    return latchedMessage(record)
  }
  if (code === 'execution_owner_reconciling') {
    return 'Orca is still working out who owns this session on this machine. Reopen the chat in a moment.'
  }
  return null
}
