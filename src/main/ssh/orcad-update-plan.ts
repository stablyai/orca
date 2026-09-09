/**
 * When an update may restart orcad, and when going back is still sound.
 *
 * Two constraints shape everything here.
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

/**
 * Decide whether to restart orcad onto `candidateVersion`.
 *
 * Deferring on live terminals is a deliberate choice, not caution. The restart itself is
 * non-destructive, but it leaves the host running a NEW orcad against an OLD daemon until
 * every one of those terminals exits — a mixed pair whose duration the operator, not the
 * deploy, should decide. `force` is how they decide it.
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
          'stays pinned against GC.'
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
          'against GC because that daemon was forked from it.'
      ]
    }
  }
  return {
    action: 'proceed',
    // Zero live sessions is the one case where daemon-init's freshness branch replaces the
    // daemon, so nothing is carried across and nothing is lost.
    preservesLiveDaemon: false,
    notes: [
      'No terminals are running, so the daemon is replaced by one forked from the new bundle.'
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
