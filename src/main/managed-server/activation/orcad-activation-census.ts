/** Which census an activation may plan on, and when it asks the candidate which daemons are alive. */
import type { OrcadDeployOptions } from '../install/orcad-remote-deploy'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { planOrcadUpdate, type OrcadUpdateForce } from './orcad-update-plan'
import {
  isAnsweredOrcadTerminalCensus,
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import {
  censusNeedsHostDaemonProtocols,
  CURRENT_ORCAD_DAEMON_PROTOCOL
} from './orcad-daemon-protocol-crossing'

export type OrcadUpdatePlan = ReturnType<typeof planOrcadUpdate>

export function countedLockedRecord(
  options: Pick<OrcadDeployOptions, 'censusRecord'>,
  record: OrcadActivationRecord
): boolean {
  const counted = options.censusRecord
  return (
    !counted || (counted.active === record.active && counted.activatedAt === record.activatedAt)
  )
}

/** A census of another incumbent cannot authorize stopping this one. */
export function censusForLockedRecord(
  options: Pick<OrcadDeployOptions, 'censusRecord' | 'census'>,
  record: OrcadActivationRecord
): OrcadTerminalCensus {
  return countedLockedRecord(options, record) ? options.census : UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
}

/** Old hosts cannot name mixed generations, nor a dead daemon count sessions; the candidate can. */
export function asksCandidateForLiveDaemons(
  census: OrcadTerminalCensus,
  force: OrcadUpdateForce | undefined
): boolean {
  // Only full force probes an uncounted census: a failed probe must not mark a deferred host incompatible.
  return (
    censusNeedsHostDaemonProtocols(census) ||
    (force === true && census.liveSessions === null && isAnsweredOrcadTerminalCensus(census))
  )
}

export function orcadUpdatePlanner(
  record: OrcadActivationRecord,
  candidateVersion: string,
  force: OrcadUpdateForce | undefined
): (census: OrcadTerminalCensus, hostDaemonProtocols?: readonly number[]) => OrcadUpdatePlan {
  return (census, hostDaemonProtocols) =>
    planOrcadUpdate({
      record,
      candidateVersion,
      census,
      candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
      ...(hostDaemonProtocols ? { hostDaemonProtocols } : {}),
      ...(force !== undefined ? { force } : {})
    })
}
