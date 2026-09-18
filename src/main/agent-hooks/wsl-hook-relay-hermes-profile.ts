import { AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD } from '../../shared/agent-hook-relay'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

type HermesProfileState = {
  phase: 'starting' | 'running' | 'failed'
  mux?: SshChannelMultiplexer
  hermesProfile?: string
}

export function updateWslRelayHermesProfile(
  state: HermesProfileState,
  profile: string | undefined
): void {
  if (!profile || profile === state.hermesProfile) {
    return
  }
  state.hermesProfile = profile
  if (state.mux && state.phase === 'running') {
    void state.mux
      .request(AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD, {
        agents: ['hermes'],
        profile
      })
      .catch(() => undefined)
  }
}

export function wslRelayLaunchCommandForHermesProfile(
  profile: string | undefined
): string | undefined {
  return profile ? `hermes --profile ${profile}` : undefined
}
