import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'

// Orca's journal is only a BOUNDED view of the provider thread: the restore ceiling refuses
// oversized histories, compaction and epoch rolls replace journal items, and a tombstoned turn
// leaves the provider copy in place. So a provider turn Orca never journaled is not evidence of a
// bad fork, and demanding an exact match would make every long or edited conversation unforkable.
// The invariant that does matter is directional — everything Orca RETAINED survived the fork
// unrenamed and in order, and the cut landed on the selected turn.

/** Codex turn ids Orca retained, in journal order, deduplicated on first appearance. */
function retainedCodexTurnIds(fork: AgentSessionForkTarget): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const key of fork.retainedItemIds ?? []) {
    const identity = parseAgentJournalItemKey(key)
    if (identity?.provider !== 'codex' || seen.has(identity.turnId)) {
      continue
    }
    seen.add(identity.turnId)
    ordered.push(identity.turnId)
  }
  return ordered
}

export function assertCodexForkedIdentities(
  threadId: string,
  fork: AgentSessionForkTarget,
  identities: readonly AgentJournalItemIdentity[]
): void {
  const actual = new Set(identities.map((identity) => agentJournalItemKey(identity)))
  for (const itemId of fork.retainedItemIds ?? []) {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider !== 'codex') {
      continue
    }
    // Same turn id and ordinal under the child thread: a renumbered copy would duplicate on
    // hydration, so it must refuse rather than publish.
    const expectedKey = agentJournalItemKey({
      provider: 'codex',
      threadId,
      turnId: identity.turnId,
      ordinal: identity.ordinal
    })
    if (!actual.has(expectedKey)) {
      throw new Error('agent_session_fork:proof-mismatch')
    }
  }
  if (!retainedCodexTurnIds(fork).includes(fork.throughId)) {
    throw new Error('agent_session_fork:proof-mismatch')
  }
}

/**
 * `turnIds` is the forked thread's turn list as the paginated reader collected it: newest first,
 * because every page is requested `sortDirection: 'desc'`.
 */
export function assertCodexForkedTurnIds(
  fork: AgentSessionForkTarget,
  turnIds: readonly string[]
): void {
  const retained = retainedCodexTurnIds(fork)
  // The newest forked turn is the one the user selected; anything after it means the provider
  // ignored `lastTurnId` and copied more of the parent than was asked for.
  if (!retained.includes(fork.throughId) || turnIds[0] !== fork.throughId) {
    throw new Error('agent_session_fork:proof-mismatch')
  }
  const forked = turnIds.toReversed()
  let after = 0
  for (const turnId of retained) {
    const at = forked.indexOf(turnId, after)
    if (at === -1) {
      throw new Error('agent_session_fork:proof-mismatch')
    }
    after = at + 1
  }
}
