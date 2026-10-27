import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export type WslRelayDistroState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  child?: { kill: () => void }
  mux?: SshChannelMultiplexer
  guestHome?: string
  codexHomePath?: string
  guestEndpointFilePath?: string
  claudeAgentViewDir?: string
  claudeConfigDir?: string
  opencodeOverlayDir?: string
  opencode2OverlayDir?: string
  piAgentDir?: string
  ompStatusExtension?: string
  launchKinds: Set<'pi' | 'omp'>
  startup?: Promise<void>
  installation?: Promise<void>
  failures: number
  cooldownUntil: number
  connectedAt?: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
  lastInstallAt?: number
  lastOpenCodeSettings?: string
  lastAttemptOpenCodeSettings?: string
  lastInstallMux?: SshChannelMultiplexer
}

/** The config a relay served, kept across a stopped-distro drop so its restart brings it all back. */
export type WslRelayRestartSetup = Pick<
  WslRelayDistroState,
  | 'codexHomePath'
  | 'claudeAgentViewDir'
  | 'claudeConfigDir'
  | 'opencodeOverlayDir'
  | 'opencode2OverlayDir'
  | 'piAgentDir'
  | 'ompStatusExtension'
> & { launchKinds: readonly ('pi' | 'omp')[] }
