import type { SpawnedProcessWithStreams } from '../../shared/child-process/process-spec'

import { FAILURE_COOLDOWN_MAX_MS, type WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import type { WslRelayRecovery } from './wsl-hook-relay-recovery'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

type WslRelayFailureState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  failures: number
  child?: SpawnedProcessWithStreams
  mux?: SshChannelMultiplexer
  cooldownUntil: number
  reinstallTimer?: ReturnType<typeof setTimeout>
}

/** Record a failed relay and arm bounded self-recovery. */
export function markWslRelayFailed(
  deps: Pick<WslHookRelayManagerDeps, 'warn'>,
  recovery: WslRelayRecovery,
  state: WslRelayFailureState,
  message: string,
  cooldownBaseMs: number
): void {
  state.phase = 'failed'
  state.failures += 1
  state.child = undefined
  state.mux = undefined
  if (state.reinstallTimer) {
    clearTimeout(state.reinstallTimer)
    state.reinstallTimer = undefined
  }
  state.cooldownUntil =
    Date.now() + Math.min(cooldownBaseMs * state.failures, FAILURE_COOLDOWN_MAX_MS)
  deps.warn(`[agent-hooks] WSL hook relay (${state.distro}): ${message}`)
  recovery.scheduleRestart(state)
}
