/**
 * Asks a managed orcad, through its tunnel, how many terminals its daemon runs. Every failure,
 * including an older host without the method, reads as an unverifiable census, never as zero.
 */
import { ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
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

export const UNVERIFIABLE_ORCAD_TERMINAL_CENSUS: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

export async function collectRemoteOrcadTerminalCensus(
  environment: KnownRuntimeEnvironment,
  record: OrcadActivationRecord,
  timeoutMs = 15_000
): Promise<OrcadTerminalCensus> {
  if (!record.active) {
    return collectIdle()
  }
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  }
  try {
    const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
      getPreferredPairingOffer(environment),
      ORCAD_TERMINAL_CENSUS_METHOD,
      { activatedAt },
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
    return response.ok
      ? OrcadTerminalCensusSchema.parse(response.result)
      : UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  } catch {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  }
}

/** The census through the server's ensured tunnel; a tunnel that cannot open is unverifiable. */
export async function collectManagedTerminalCensus(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  record: OrcadActivationRecord
): Promise<OrcadTerminalCensus> {
  if (!record.active) {
    return collectIdle()
  }
  try {
    await ensureOrcadManagedTunnel(userDataPath, environment.id)
  } catch {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  }
  return collectRemoteOrcadTerminalCensus(environment, record)
}

function collectIdle(): OrcadTerminalCensus {
  return { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
}
