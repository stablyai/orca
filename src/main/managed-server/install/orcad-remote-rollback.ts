// Rollback restores a pre-activation snapshot: older builds may not understand newer state.
// Stop, rescue, restore, then launch; the rescue and fenced journal allow recovery of interrupted steps.
import { logOrcadActivationOutcome } from '../activation/orcad-activation-outcome-log'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import type { OrcadTerminalCensus } from '../../../shared/orcad-terminal-census'
import type { OrcadActivationVerdict } from '../activation/orcad-activation-gate'
import type { OrcadDaemonProtocolFacts } from '../../ssh/orcad-daemon-protocol-crossing'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { sameOrcadActivationRecord } from '../activation/orcad-activation-transaction'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock
} from '../activation/orcad-activation-lock'
import { orcadActivationFenceRefusal } from '../activation/orcad-activation-fence-hold'
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/orcad-profile-preflight'
import { rollbackOrcadLocked } from '../lifecycle/orcad-rollback-transition'

export type OrcadRollbackOptions = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  record: OrcadActivationRecord
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  census: OrcadTerminalCensus
  /** Close terminal admission, then recount under the host lock; any failure is unverifiable. */
  recountCensus: () => Promise<OrcadTerminalCensus>
  /** Reopen admission if rollback leaves the incumbent serving. */
  releaseIncumbentAdmission: () => Promise<void>
  /** Expected hash from the client's copy of the rollback target. */
  targetBuildHash: string
  /** Protocol facts from the same target bytes. */
  targetDaemonProtocol: OrcadDaemonProtocolFacts
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
  const options = {
    ...input,
    readinessTimeoutMs: resolveOrcadActivationReadinessTimeout(
      input.readinessTimeoutMs,
      ORCAD_STARTUP_READINESS_TIMEOUT_MS
    )
  }
  return logOrcadActivationOutcome(
    `rollback to ${options.record.previous ?? 'none'}`,
    () =>
      withOrcadActivationLock(
        options,
        async (lock) => {
          if (
            !sameOrcadActivationRecord(await readOrcadActivationRecord(options), options.record)
          ) {
            return {
              outcome: 'refused',
              code: 'orcad_rollback_record_changed',
              reason:
                'The host activation record changed while this rollback was waiting. Refresh the ' +
                'host state and review the new rollback target before trying again.'
            }
          }
          return rollbackOrcadLocked(options, lock)
        },
        async () => {
          const { code, reason } = await orcadActivationFenceRefusal(options, 'rollback')
          return { outcome: 'refused', code, reason }
        }
      ),
    ['rolled-back']
  )
}
