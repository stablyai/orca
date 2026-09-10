// Recovering the agent-session store from its backup, without minting a second writer.
//
// The backup is the previous committed generation. The commit that never landed may have granted a
// fence one higher than anything the backup records show, and `isAgentSessionFenceCurrent` compares
// with STRICT EQUALITY — so a next-fence of `recordFence + 1` would *equal* that lost grant and
// accept a writer holding it. `+2` strictly dominates it.
//
// The bound "one lost commit can advance a session's fence by at most 1" is what makes +2 enough.
// It holds because every mint site routes through `nextAgentSessionFence` and each performs one
// transition per transaction, and because the save path aborts rather than letting the primary
// advance past a stale backup. A batching refactor would break it silently, so it is pinned by a
// test.
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

import type { AgentSessionStoreState } from './agent-session-record-store-file'

/** Strictly above any fence the lost commit could have granted for that session. */
export const AGENT_SESSION_BACKUP_RECOVERY_FENCE_MARGIN = 2

export function raiseAgentSessionFencesAfterBackupRecovery(state: AgentSessionStoreState): void {
  for (const [sessionId, record] of state.records) {
    const floor = record.lease.runtimeFence + AGENT_SESSION_BACKUP_RECOVERY_FENCE_MARGIN
    state.records.set(sessionId, {
      ...record,
      lease: {
        ...record.lease,
        minimumNextFence: Math.max(floor, record.lease.minimumNextFence ?? 0)
      }
    })
  }
}
