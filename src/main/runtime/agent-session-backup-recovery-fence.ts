// Recovering the agent-session store from its backup, without minting a second writer.
//
// The backup is the previous committed generation. The commit that never landed may have granted a
// fence chosen by `nextAgentSessionFence` from the backup lease, and
// `isAgentSessionFenceCurrent` compares with STRICT EQUALITY. That choice may already be above
// `runtimeFence + 1` after an earlier recovery; the new floor must strictly dominate it.
//
// The bound is one lost mint per backup generation: each mint site uses
// `nextAgentSessionFence` once per transaction, and the save path aborts rather than advancing the
// primary past a stale backup. A source-level ratchet rejects direct `+ 1` mints; an indirected
// mint is not caught.
//
// This records a FLOOR for the next grant and leaves the current fence alone. Rewriting the current
// fence is what an earlier version did, and it corrupted exactly the records it meant to save: a
// `live` lease means a provider handle proven at exactly `lease.runtimeFence`, asserted by
// `isValidAgentSessionRecord`, so a fence bumped without a re-proof — which cannot happen offline —
// made the record invalid, quarantined it on the next load, and dropped back to the same backup.
//
// Ownership is deliberately untouched. `claimStatus` (a conflict must survive restart),
// `ownerProcess` (the identity evidence the owner probe needs — the lease owner is a child process
// that can outlive a main-process crash) and `handoffStage` all carry forward verbatim. Loading
// already marks every lease unreconciled, and the restart reconciler re-adjudicates them by probe
// once transactions are admitted. Nulling that evidence is how you get two writers on one provider
// session; the fence protects the store, not the provider session.

import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

export function raiseAgentSessionFencesAfterBackupRecovery(state: AgentSessionStoreState): void {
  for (const [sessionId, record] of state.records) {
    const floor = nextAgentSessionFence(record.lease) + 1
    if (!Number.isSafeInteger(floor)) {
      throw new Error('agent_session_fence_exhausted')
    }
    state.records.set(sessionId, {
      ...record,
      lease: {
        ...record.lease,
        minimumNextFence: floor
      }
    })
  }
}
