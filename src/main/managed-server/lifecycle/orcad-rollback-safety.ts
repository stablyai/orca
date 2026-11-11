import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import type { OrcadTerminalCensus } from '../../../shared/orcad-terminal-census'
import {
  assessOrcadLiveDaemonCrossing,
  describeDaemonProtocols
} from '../activation/orcad-daemon-protocol-crossing'

import type { OrcadDaemonProtocolFacts } from '../activation/orcad-daemon-protocol-crossing'

type OrcadRollbackSafety =
  | { safety: 'clean'; target: string; notes: string[] }
  | { safety: 'lossy'; target: string; discards: string[] }
  | { safety: 'unsafe'; code: OrcadRollbackUnsafeCode; reason: string }

type OrcadRollbackUnsafeCode =
  | 'orcad_rollback_no_target'
  | 'orcad_rollback_snapshot_missing'
  | 'orcad_rollback_orphans_live_terminals'
  | 'orcad_rollback_census_unavailable'
  | 'orcad_rollback_snapshot_unverifiable'
  | 'orcad_rollback_strands_live_terminals'
  | 'orcad_rollback_daemon_protocol_unverifiable'

/** Restoring a pre-activation snapshot discards later state. Post-activation terminal creation makes rollback unsafe: the surviving daemon would own PTYs absent from restored rows. Settings/UI-only changes are merely lossy. */
export function assessOrcadRollback(input: {
  record: OrcadActivationRecord
  /** Whether the snapshot is still on the host; `null` means the probe was unverifiable. */
  snapshotPresent: boolean | null
  census: OrcadTerminalCensus
  /** The rollback target's daemon protocol facts, from the client's copy of its bytes. */
  targetDaemonProtocol: OrcadDaemonProtocolFacts
  /** Compare shared-store mtime to activation; unknown writes are treated as present rather than claiming unproven lossless rollback. */
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
  if (input.record.snapshot && input.snapshotPresent === null) {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_snapshot_unverifiable',
      reason:
        'The host did not give a trustworthy answer about the pre-activation snapshot. Retry ' +
        'when the host is reachable; loss of contact is not evidence the snapshot is gone.'
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
  const crossing = assessOrcadLiveDaemonCrossing(input.census, input.targetDaemonProtocol)
  if (crossing.state === 'unverifiable') {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_daemon_protocol_unverifiable',
      reason:
        'The terminal daemon did not report its protocol, so this rollback cannot show that ' +
        `${target} would reach the terminals still running. Retry when the daemon answers.`
    }
  }
  if (crossing.state === 'strands-live-terminals') {
    return {
      safety: 'unsafe',
      code: 'orcad_rollback_strands_live_terminals',
      reason:
        `A terminal daemon on this host speaks ${describeDaemonProtocols(crossing.unattachable)}, ` +
        `which ${target} does not list. Rolling back now would leave any terminals it runs ` +
        'unreachable. Roll back when no terminals are running, or deploy forward.'
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
