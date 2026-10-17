/**
 * R32 for an SSH-managed update: the last census closes the incumbent's terminal admission before
 * counting, so no terminal starts between that count and the stop; a deferred update reopens it.
 */
import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  type OrcadTerminalCensus
} from '../../shared/orcad-terminal-census'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import type { OrcadDeployOptions } from './orcad-remote-deploy'
import {
  requestOrcadTerminalCensus,
  type OrcadTerminalCensusRequestOptions
} from './orcad-terminal-census-client'

type CountIncumbent = (options: OrcadTerminalCensusRequestOptions) => Promise<OrcadTerminalCensus>

export function sshUpdateAdmissionFence(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  record: OrcadActivationRecord,
  preUploadCensus: OrcadTerminalCensus,
  count: CountIncumbent = (options) =>
    countRunningIncumbent(userDataPath, environment, record, options)
): Pick<OrcadDeployOptions, 'recountCensus' | 'releaseIncumbentAdmission'> {
  return {
    recountCensus: async () => {
      const recount = await count({
        releaseFinishedAutomationTerminals: true,
        closeAdmissionForMs: ORCAD_UPDATE_ADMISSION_FENCE_MS
      })
      // An unanswered or unfenced recount keeps the pre-upload count, so an SSH update defers no
      // more than before; a fenced server that could not settle its spawns stays unverifiable.
      return recount.liveSessions === null && recount.admissionClosedUntil === undefined
        ? preUploadCensus
        : recount
    },
    releaseIncumbentAdmission: async () => {
      await count({ closeAdmissionForMs: 0 })
    }
  }
}

const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

// Why not collectManagedTerminalCensus: it wakes a stopped server, which must not happen while
// the activation holds this host's lock. A server that stopped since the first count is unverifiable.
async function countRunningIncumbent(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  record: OrcadActivationRecord,
  options: OrcadTerminalCensusRequestOptions
): Promise<OrcadTerminalCensus> {
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!record.active || !Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE
  }
  try {
    await ensureOrcadManagedTunnel(userDataPath, environment.id)
    return await requestOrcadTerminalCensus(
      getPreferredPairedRuntimeConnection(environment),
      activatedAt,
      15_000,
      options
    )
  } catch {
    return UNVERIFIABLE
  }
}
