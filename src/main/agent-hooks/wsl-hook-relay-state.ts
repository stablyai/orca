import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export type WslRelayDistroState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  child?: { kill: () => void }
  mux?: SshChannelMultiplexer
  guestHome?: string
  codexHomePath?: string
  guestEndpointFilePath?: string
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
}
