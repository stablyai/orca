/**
 * When an update may restart orcad, and when going back is still sound.
 *
 * Three constraints shape everything here.
 *
 * **The daemon must outlive the restart.** orcad forks the terminal daemon and deliberately
 * does not kill it on stop (`orcad-daemon-supervision.ts` uses `disconnectDaemon`, never
 * `shutdownDaemon`). An update that killed it would destroy every terminal on the host —
 * the thing the daemon exists to prevent. After an update the surviving daemon was forked
 * from the OUTGOING bundle, so `daemon-init` sees an entry-path/version mismatch and takes
 * its `shouldPreserveDaemonWithLiveSessions` branch: with live sessions it preserves the old
 * daemon; at exactly zero it replaces it. Both are correct, and both mean the outgoing
 * version's directory is still load-bearing.
 *
 * **The state root is shared across versions.** `~/.orca/` (or `$ORCA_USER_DATA`) is outside
 * every version dir, and Orca's persisted state carries no schema version — migrations run
 * on load and rewrite in place. So "is the old version able to read what the new one wrote"
 * has no answer that can be computed. That is why rollback is defined against a
 * pre-activation snapshot rather than against a version comparison.
 *
 * **Structured agent sessions do NOT outlive the restart.** Their provider processes are
 * children of the orcad runtime, which the update stops and replaces, not of the daemon it
 * preserves. So the thing that makes a terminal safe to restart under does not apply to them,
 * and they need their own term in the census rather than being covered by the daemon's count.
 */
import type { OrcadActivationRecord } from './orcad-activation-record'

export type OrcadTerminalCensus = {
  /**
   * Sessions the live daemon owns right now. `null` means the probe could not answer —
   * never treated as zero, because loss of contact is not evidence of process death
   * (docs/reference/ssh-execution-boundary.md).
   */
  liveSessions: number | null
  /**
   * Of those, how many started at or after `record.activatedAt`. These are the sessions the
   * pre-activation snapshot does not describe.
   */
  startedSinceActivation: number | null
  /**
   * Structured agent sessions with a live provider child, read from the session record store of
   * the host being updated. `null` carries the same meaning as above, for the same reason, and
   * it is a separate term because these providers are children of the orcad runtime rather than
   * of the terminal daemon — the restart ends them instead of carrying them across.
   */
  liveStructuredSessions: number | null
}

export type OrcadUpdateDecision =
  | { action: 'noop'; reason: string }
  | {
      action: 'proceed'
      /** True when a live daemon will be carried across the restart rather than replaced. */
      preservesLiveDaemon: boolean
      notes: string[]
    }
  | { action: 'defer'; code: OrcadUpdateDeferCode; reason: string }

export type OrcadUpdateDeferCode =
  | 'orcad_update_terminals_running'
  | 'orcad_update_terminal_census_unavailable'
  | 'orcad_update_structured_sessions_running'
  | 'orcad_update_structured_census_unavailable'

type OrcadUpdateDeferral = Extract<OrcadUpdateDecision, { action: 'defer' }>

/**
 * The structured term, with an absent field read as unprobeable. A census assembled by a path
 * that never learned this term is incomplete, and incomplete must not read as zero.
 */
function structuredSessionCount(census: OrcadTerminalCensus): number | null {
  return census.liveStructuredSessions ?? null
}

/**
 * Why structured sessions are the stricter of the two arms, and are decided first: their
 * providers are children of the orcad runtime, not of the terminal daemon orcad deliberately
 * preserves. The restart terminals survive kills them outright, mid-turn included, so when both
 * are in play the operator should hear about the loss that has no way back.
 */
function deferForStructuredSessions(live: number | null): OrcadUpdateDeferral | null {
  if (live === null) {
    return {
      action: 'defer',
      code: 'orcad_update_structured_census_unavailable',
      reason:
        'The runtime did not answer how many structured agent sessions are live, so this update ' +
        'cannot tell whether a turn is in flight. Unlike terminals, those sessions do not ' +
        'survive the restart. Retry, or force the update knowing one may be mid-turn.'
    }
  }
  if (live > 0) {
    return {
      action: 'defer',
      code: 'orcad_update_structured_sessions_running',
      reason:
        `${live} structured agent session${live === 1 ? ' is' : 's are'} running on this host. ` +
        'The restart would end them: their provider processes are children of orcad itself, not ' +
        'of the daemon it preserves, so any turn in flight is lost. Update when the host is ' +
        'idle, or force it.'
    }
  }
  return null
}

/** What a forced update is choosing to lose, said plainly in the plan it returns. */
function forcedStructuredNotes(live: number | null): string[] {
  if (live === null) {
    return [
      'Forced with an unverifiable structured session count. Any live structured session is a ' +
        'child of orcad and does not survive the restart, so a turn in flight would be lost.'
    ]
  }
  if (live > 0) {
    return [
      `Forced with ${live} live structured agent session${live === 1 ? '' : 's'}. Unlike the ` +
        'terminals they do not survive the restart — their providers are children of orcad — so ' +
        'any turn in flight is lost.'
    ]
  }
  return []
}

/**
 * Decide whether to restart orcad onto `candidateVersion`.
 *
 * Deferring on live terminals is a deliberate choice, not caution. The restart itself is
 * non-destructive, but it leaves the host running a NEW orcad against an OLD daemon until
 * every one of those terminals exits — a mixed pair whose duration the operator, not the
 * deploy, should decide. `force` is how they decide it.
 *
 * Structured sessions are the harsher case — the restart ends them — so they are decided first
 * and their loss is named in the notes whenever `force` overrides the deferral.
 */
export function planOrcadUpdate(input: {
  record: OrcadActivationRecord
  candidateVersion: string
  census: OrcadTerminalCensus
  force?: boolean
}): OrcadUpdateDecision {
  if (input.record.active === input.candidateVersion) {
    return {
      action: 'noop',
      reason: `${input.candidateVersion} is already the active version; nothing to restart.`
    }
  }
  const structured = structuredSessionCount(input.census)
  if (!input.force) {
    const structuredDeferral = deferForStructuredSessions(structured)
    if (structuredDeferral) {
      return structuredDeferral
    }
  }
  const structuredNotes = input.force ? forcedStructuredNotes(structured) : []
  const { liveSessions } = input.census
  if (liveSessions === null) {
    if (!input.force) {
      return {
        action: 'defer',
        code: 'orcad_update_terminal_census_unavailable',
        reason:
          'The terminal daemon did not answer a session count, so this update cannot tell ' +
          'whether work is running on the host. Retry, or force the update knowing terminals ' +
          'may be mid-flight.'
      }
    }
    return {
      action: 'proceed',
      // Why true: an unverifiable census must be planned for as if sessions exist. Assuming
      // the daemon is replaceable is the assumption that destroys terminals.
      preservesLiveDaemon: true,
      notes: [
        'Forced with an unverifiable session count. Planning as if terminals are live: the ' +
          'daemon will be preserved across the restart, and the outgoing version directory ' +
          'stays pinned against GC.',
        ...structuredNotes
      ]
    }
  }
  if (liveSessions > 0 && !input.force) {
    return {
      action: 'defer',
      code: 'orcad_update_terminals_running',
      reason:
        `${liveSessions} terminal${liveSessions === 1 ? ' is' : 's are'} running on this host. ` +
        'The restart would not kill them — the daemon is preserved — but the host would run ' +
        `orcad ${input.candidateVersion} against a daemon forked from ` +
        `${input.record.active ?? 'the previous build'} until they all exit. Update when the ` +
        'host is idle, or force it.'
    }
  }
  if (liveSessions > 0) {
    return {
      action: 'proceed',
      preservesLiveDaemon: true,
      notes: [
        `Forced with ${liveSessions} live terminal${liveSessions === 1 ? '' : 's'}. They survive ` +
          'the restart on the existing daemon; the outgoing version directory stays pinned ' +
          'against GC because that daemon was forked from it.',
        ...structuredNotes
      ]
    }
  }
  return {
    action: 'proceed',
    // Zero live sessions is the one case where daemon-init's freshness branch replaces the
    // daemon, so nothing is carried across and nothing is lost.
    preservesLiveDaemon: false,
    notes: [
      'No terminals are running, so the daemon is replaced by one forked from the new bundle.',
      ...structuredNotes
    ]
  }
}

export type OrcadRollbackSafety =
  | { safety: 'clean'; target: string; notes: string[] }
  | { safety: 'lossy'; target: string; discards: string[] }
  | { safety: 'unsafe'; code: OrcadRollbackUnsafeCode; reason: string }

export type OrcadRollbackUnsafeCode =
  | 'orcad_rollback_no_target'
  | 'orcad_rollback_snapshot_missing'
  | 'orcad_rollback_orphans_live_terminals'
  | 'orcad_rollback_census_unavailable'

/**
 * How safe it is to switch back to `record.previous`.
 *
 * **The point past which rollback is unsafe is the first terminal created after
 * activation.** Not the first state write, and not any schema comparison:
 *
 *  - Rolling back means restoring the pre-activation snapshot, because there is no schema
 *    version to prove the old build can read what the new one wrote.
 *  - The snapshot predates activation, so it does not describe sessions created since.
 *  - The daemon survives the binary swap and still owns those sessions. After the restore,
 *    a live daemon holds PTYs that the restored store has no rows for: work that is running,
 *    that no client can reattach to, and that the host will report as neither `live` nor
 *    `exited` for any session anyone can name.
 *
 * Settings and UI churn written after activation are merely discarded, which is `lossy`.
 * Orphaning running work is not something a deploy gets to do quietly, so it is `unsafe`.
 */
export function assessOrcadRollback(input: {
  record: OrcadActivationRecord
  /** Whether the snapshot named by the record is actually still on the host. */
  snapshotPresent: boolean
  census: OrcadTerminalCensus
  /**
   * Whether the shared store has been written since activation, from its mtime against
   * `record.activatedAt`. `null` means unknown, which is treated as "yes" — claiming a
   * lossless rollback we cannot demonstrate is the failure mode, not the caution.
   */
  stateWritesSinceActivation: boolean | null
}): OrcadRollbackSafety {
  const target = input.record.previous
  if (!target) {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_no_target',
      reason:
        'This host has no previous orcad version recorded, so there is nothing to roll back ' +
        'to. Deploy a known-good build instead.'
    }
  }
  if (!input.record.snapshot || !input.snapshotPresent) {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_snapshot_missing',
      reason:
        `The pre-activation state snapshot for ${input.record.active ?? 'the active version'} ` +
        'is gone, and Orca state carries no schema version that could prove the older build ' +
        'can read what the newer one migrated. Switching the binary back would hand ' +
        `${target} a store it may not understand. Deploy forward instead.`
    }
  }
  const { startedSinceActivation } = input.census
  if (startedSinceActivation === null) {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_census_unavailable',
      reason:
        'The daemon did not answer how many of its terminals started after this version was ' +
        'activated, so a snapshot restore might orphan running work. Retry when the host is ' +
        'reachable.'
    }
  }
  if (startedSinceActivation > 0) {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_orphans_live_terminals',
      reason:
        `${startedSinceActivation} terminal${startedSinceActivation === 1 ? '' : 's'} started ` +
        'after this version was activated. The daemon survives the rollback and would keep ' +
        'owning them, but the restored snapshot predates them, so nothing would be able to ' +
        'reattach. Close them (or let them exit) and roll back then.'
    }
  }
  if (input.stateWritesSinceActivation === false) {
    return {
      safety: 'clean',
      target,
      notes: [
        'The pre-activation snapshot is intact, no terminals started since activation, and ' +
          'the store has not been written since. Restoring it changes nothing.'
      ]
    }
  }
  return {
    safety: 'lossy',
    target,
    discards: [
      input.stateWritesSinceActivation === null
        ? 'Any profile, settings and UI change written since activation — the store mtime ' +
          'could not be read, so assume there are some.'
        : `Every profile, settings and UI change written since ${
            input.record.activatedAt ?? 'activation'
          }, when ${input.record.active ?? 'the active version'} was activated.`
    ]
  }
}
