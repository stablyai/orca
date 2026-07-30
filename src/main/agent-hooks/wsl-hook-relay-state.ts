import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_SET_CONTEXT_PRESSURE_METHOD } from '../../shared/agent-hook-relay'

export type WslHookRelayState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  child?: ChildProcessWithoutNullStreams
  mux?: SshChannelMultiplexer
  guestHome?: string
  guestEndpointFilePath?: string
  opencodeOverlayDir?: string
  failures: number
  cooldownUntil: number
  connectedAt?: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
  lastInstallAt?: number
}

export function wslHookRelayDistroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export class WslContextPressureRelayState {
  private enabled = false

  setEnabled(enabled: boolean, states: Iterable<WslHookRelayState>): void {
    this.enabled = enabled
    for (const state of states) {
      this.sync(state.mux)
    }
  }

  sync(mux: SshChannelMultiplexer | undefined): void {
    mux?.notify(AGENT_HOOK_SET_CONTEXT_PRESSURE_METHOD, { enabled: this.enabled })
  }
}
