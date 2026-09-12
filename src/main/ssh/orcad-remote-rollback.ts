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
 * The order below is the whole safety argument: stop, then restore, then start. Restoring
 * under a running orcad would replace the store beneath a process holding it open, and
 * starting before restoring would let the old build migrate the new build's state — the
 * failure this is meant to avoid, arrived at from the other side.
 */

import type { SshConnection } from './ssh-connection'
import {
  serializeOrcadActivationRecord,
  type OrcadActivationRecord
} from './orcad-activation-record'
import type { OrcadTerminalCensus } from './orcad-update-plan'
import type { OrcadActivationVerdict } from './orcad-activation-gate'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { withOrcadActivationLock } from './orcad-activation-lock'
import type { ServeReadiness } from '../server/serve-readiness'
import { rollbackLocked } from './orcad-rollback-transition'

export type OrcadRollbackOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  record: OrcadActivationRecord
  nodePath?: string
  userDataDir: string
  bindHost: string
  port: number
  census: OrcadTerminalCensus
  /** Expected build hash of the rollback target, from the client's copy of those bytes. */
  targetBuildHash: string
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadRollbackResult =
  | {
      outcome: 'rolled-back'
      target: string
      discarded: string[]
      verdict: OrcadActivationVerdict
      readiness: ServeReadiness
    }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

export async function rollbackOrcad(options: OrcadRollbackOptions): Promise<OrcadRollbackResult> {
  return withOrcadActivationLock(options, async (lock) => {
    const currentRecord = await readOrcadActivationRecord(options)
    if (
      serializeOrcadActivationRecord(currentRecord) !==
      serializeOrcadActivationRecord(options.record)
    ) {
      return {
        outcome: 'refused',
        code: 'orcad_rollback_record_changed',
        reason:
          'The host activation record changed while this rollback was waiting. Refresh the ' +
          'host state and review the new rollback target before trying again.'
      }
    }
    return rollbackLocked({ ...options, record: currentRecord }, lock)
  })
}
