import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export type WslHookRelayDistroState = {
  /** Original casing for wsl.exe argv and breadcrumbs; map keys are lowercased. */
  distro: string
  phase: 'starting' | 'running' | 'failed'
  child?: ChildProcessWithoutNullStreams
  mux?: SshChannelMultiplexer
  guestHome?: string
  codexHomePath?: string
  guestEndpointFilePath?: string
  opencodeOverlayDir?: string
  failures: number
  cooldownUntil: number
  connectedAt?: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
  lastInstallAt?: number
}
