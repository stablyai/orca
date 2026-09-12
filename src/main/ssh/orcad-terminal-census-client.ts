import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  OrcadTerminalCensusSchema,
  type OrcadTerminalCensus
} from '../../shared/orcad-terminal-census'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type { OrcadActivationRecord } from './orcad-activation-record'

const UNVERIFIABLE_CENSUS: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null
}

export async function collectRemoteOrcadTerminalCensus(
  environment: KnownRuntimeEnvironment,
  record: OrcadActivationRecord,
  timeoutMs = 15_000
): Promise<OrcadTerminalCensus> {
  if (!record.active) {
    return { liveSessions: 0, startedSinceActivation: 0 }
  }
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE_CENSUS
  }
  try {
    const response = await sendRemoteRuntimeRequest<unknown>(
      getPreferredPairingOffer(environment),
      'orcad.terminalCensus',
      { activatedAt },
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (!response.ok) {
      return UNVERIFIABLE_CENSUS
    }
    return OrcadTerminalCensusSchema.parse(response.result)
  } catch {
    return UNVERIFIABLE_CENSUS
  }
}
