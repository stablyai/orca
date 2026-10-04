import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_SET_CONTEXT_PRESSURE_METHOD } from '../../shared/agent-hook-relay'

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
  lastOpenCodeSettings?: string
  lastAttemptOpenCodeSettings?: string
  lastInstallMux?: SshChannelMultiplexer
}

export class WslContextPressureRelayState {
  private enabled = false

  setEnabled(enabled: boolean, states: Iterable<WslRelayDistroState>): void {
    this.enabled = enabled
    for (const state of states) {
      this.sync(state.mux)
    }
  }

  sync(mux: SshChannelMultiplexer | undefined): void {
    mux?.notify(AGENT_HOOK_SET_CONTEXT_PRESSURE_METHOD, { enabled: this.enabled })
  }
}
