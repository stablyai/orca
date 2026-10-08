/**
 * Asks a managed orcad, through its tunnel, how many terminals its daemon runs. Every failure,
 * including an older host without the method, reads as an unverifiable census, never as zero.
 */
import { ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  ORCAD_TERMINAL_CENSUS_METHOD,
  OrcadTerminalCensusSchema,
  type OrcadTerminalCensus
} from '../../shared/orcad-terminal-census'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { verifyOrcadManagedServing } from './orcad-managed-serving-verify'

const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
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
  options: { releaseFinishedAutomationTerminals?: boolean } = {}
): Promise<OrcadTerminalCensus> {
  if (!record.active) {
    return { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  }
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE
  }
  try {
    await ensureOrcadManagedTunnel(userDataPath, environment.id)
    // A server that idled out behind a forward still up is started first, or it never answers.
    await verifyOrcadManagedServing(userDataPath, environment.id)
    const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
      getPreferredPairingOffer(environment),
      ORCAD_TERMINAL_CENSUS_METHOD,
      {
        activatedAt,
        ...(options.releaseFinishedAutomationTerminals
          ? { releaseFinishedAutomationTerminals: true }
          : {})
      },
      timeoutMs,
      (status) => {
        if (
          !status.ok ||
          !status.result.capabilities?.includes(ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY)
        ) {
          throw new Error('The managed Orca server does not report a terminal census.')
        }
      },
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    return response.ok ? OrcadTerminalCensusSchema.parse(response.result) : UNVERIFIABLE
  } catch {
    return UNVERIFIABLE
  }
}
