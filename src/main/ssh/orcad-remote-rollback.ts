/**
 * Going back to the previously active orcad.
 *
 * Rollback is a state operation, not a binary swap. The version dirs are immutable and both
 * are still on disk, so pointing at the old one is trivial; what is not trivial is that both
 * versions share ONE data root, outside either dir. A newer orcad migrates that root on load
 * — and Orca's persisted state carries no schema version to migrate against, so the older
 * build cannot be shown to read the result. Rollback therefore restores the pre-activation
 * snapshot, and refuses when restoring it would orphan work (`assessOrcadRollback`).
 *
 * The order is the whole safety argument: stop, rescue, restore, then start. Restoring under
 * a running orcad would replace the store beneath a process holding it open, and starting
 * before restoring would let the old build migrate the new build's state. The rescue copy of
 * the newer state, and the journal under the activation fence, make each step undoable.
 */
import type { SshConnection } from './ssh-connection'
import type { OrcadActivationRecord } from './orcad-activation-record'
import type { OrcadTerminalCensus } from './orcad-update-plan'
import type { OrcadActivationVerdict } from './orcad-activation-gate'
import type { OrcadDaemonProtocolFacts } from './orcad-daemon-protocol-crossing'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { sameOrcadActivationRecord } from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import {
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock
} from './orcad-activation-lock'
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/orcad-profile-preflight'
import { rollbackOrcadLocked } from './orcad-rollback-transition'

export type OrcadRollbackOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  record: OrcadActivationRecord
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  census: OrcadTerminalCensus
  /** Expected build hash of the rollback target, from the client's copy of those bytes. */
  targetBuildHash: string
  /** The rollback target's daemon protocol facts, from the same copy. */
  targetDaemonProtocol: OrcadDaemonProtocolFacts
  /** A fresh census for a failed target that changed state; see `orcad-incumbent-recovery.ts`. */
  terminalsStartedSince?: (since: string) => Promise<number | null>
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadRollbackResult =
  | { outcome: 'rolled-back'; target: string; discarded: string[]; verdict: OrcadActivationVerdict }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

export async function rollbackOrcad(input: OrcadRollbackOptions): Promise<OrcadRollbackResult> {
  assertPosixOrcadHost(input.host)
  const options = {
    ...input,
    readinessTimeoutMs: resolveOrcadActivationReadinessTimeout(
      input.readinessTimeoutMs,
      ORCAD_STARTUP_READINESS_TIMEOUT_MS
    )
  }
  return withOrcadActivationLock(options, async (lock) => {
    if (await readOrcadActivationTransaction(options)) {
      lock.retain()
      return {
        outcome: 'refused',
        code: 'orcad_activation_recovery_required',
        reason:
          'An earlier activation on this host was interrupted. Recover it before rolling back.'
      }
    }
    if (!sameOrcadActivationRecord(await readOrcadActivationRecord(options), options.record)) {
      return {
        outcome: 'refused',
        code: 'orcad_rollback_record_changed',
        reason:
          'The host activation record changed while this rollback was waiting. Refresh the ' +
          'host state and review the new rollback target before trying again.'
      }
    }
    return rollbackOrcadLocked(options, lock)
  })
}
