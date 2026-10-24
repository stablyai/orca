/**
 * Asks a managed orcad, through its tunnel, how many terminals its daemon runs. Every failure,
 * including an older host without the method, reads as an unverifiable census, never as zero.
 */
import { ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  ORCAD_TERMINAL_CENSUS_METHOD,
  OrcadTerminalCensusSchema,
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../shared/orcad-terminal-census'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { ensureOrcadManagedTunnel } from '../managed-server/lifecycle/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../managed-server/lifecycle/orcad-managed-serving-verify'

export type OrcadTerminalCensusRequestOptions = {
  releaseFinishedAutomationTerminals?: boolean
  /** Close the server's terminal admission this long before counting; 0 reopens it. */
  closeAdmissionForMs?: number
}

/**
 * The census through the server's ensured tunnel, after starting a server that idled out; a
 * tunnel that cannot open, or a server that cannot start, is unverifiable.
 */
export async function collectManagedTerminalCensus(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  record: OrcadActivationRecord,
  timeoutMs = 15_000,
  options: OrcadTerminalCensusRequestOptions = {}
): Promise<OrcadTerminalCensus> {
  if (!record.active) {
    return { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  }
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  }
  try {
    // Why its answer, not `environment`: the tunnel may have re-paired, retiring that token.
    const current = await ensureOrcadManagedTunnel(userDataPath, environment.id)
    // A server that idled out behind a forward still up is started first, or it never answers.
    // Not for a reopen: a server that stopped has no admission left to reopen.
    if (options.closeAdmissionForMs !== 0) {
      await verifyOrcadManagedServing(userDataPath, environment.id)
    }
    return await requestOrcadTerminalCensus(
      getPreferredPairedRuntimeConnection(current),
      activatedAt,
      timeoutMs,
      options
    )
  } catch {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  }
}

/** The census over an already-open connection; any failure is unverifiable, never zero. */
export async function requestOrcadTerminalCensus(
  connection: PairedRuntimeConnection,
  activatedAt: number,
  timeoutMs = 15_000,
  options: OrcadTerminalCensusRequestOptions = {}
): Promise<OrcadTerminalCensus> {
  try {
    const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
      connection,
      ORCAD_TERMINAL_CENSUS_METHOD,
      {
        activatedAt,
        ...(options.releaseFinishedAutomationTerminals
          ? { releaseFinishedAutomationTerminals: true }
          : {}),
        // Safe for any server: an older one drops the field, and its answer omits the fence.
        ...(options.closeAdmissionForMs === undefined
          ? {}
          : { closeAdmissionForMs: options.closeAdmissionForMs })
      },
      timeoutMs,
      (status) => {
        if (
          !status.ok ||
          !status.result.capabilities?.includes(ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY)
        ) {
          throw new Error('This host’s Orca server does not report a terminal census.')
        }
      },
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    return response.ok
      ? OrcadTerminalCensusSchema.parse(response.result)
      : UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  } catch {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  }
}
