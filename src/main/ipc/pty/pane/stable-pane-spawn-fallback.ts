import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { Store } from '../../../persistence'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { StablePaneOwner } from './stable-pane-types'

export type StablePaneSpawnContext = {
  runtime: OrcaRuntimeService | undefined
  store?: Store
  provider: IPtyProvider
  spawnOptions: PtySpawnOptions
  owner: StablePaneOwner | null
  worktreeId?: string
  connectionId?: string | null
  resolveOwner?: () => StablePaneOwner | null
  onFreshSpawn?: (result: PtySpawnResult) => void
  absenceVerdict?: PtyLivenessVerdict
}

export function withoutAgentStartupIntent(options: PtySpawnOptions): PtySpawnOptions {
  const env = options.env ? { ...options.env } : undefined
  if (env) {
    delete env.ORCA_AGENT_LAUNCH_TOKEN
  }
  return {
    ...options,
    ...(env ? { env } : {}),
    command: undefined,
    commandDelivery: undefined,
    startupCommandDelivery: undefined,
    launchAgent: undefined,
    agentSessionEnsure: undefined,
    agentSessionCreateOperationId: undefined
  }
}
