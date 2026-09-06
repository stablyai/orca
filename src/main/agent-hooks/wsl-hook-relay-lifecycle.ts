import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  runWslRelayGuestInstall,
  maybeRerunWslRelayGuestInstall
} from './wsl-hook-relay-guest-install'
import type { WslRelayRecovery } from './wsl-hook-relay-recovery'
import type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import { wireWslRelayLink } from './wsl-hook-relay-link'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_REQUEST_REPLAY_METHOD } from '../../shared/agent-hook-relay'
import {
  WSL_HOOK_FS_METHODS,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'
import { isWslRelayHooksAllowed } from './wsl-hook-relay-deps'

export type WslRelayState = {
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

export async function connectWslRelayState(options: {
  state: WslRelayState
  transport: MultiplexerTransport
  child: ChildProcessWithoutNullStreams
  instanceKey: string
  deps: WslHookRelayManagerDeps
  recovery: WslRelayRecovery
  isDisposed: () => boolean
  markFailed: (state: WslRelayState, message: string, cooldownBaseMs: number) => void
}): Promise<void> {
  const { state, transport, child, instanceKey, deps, recovery, isDisposed, markFailed } = options
  const mux = new SshChannelMultiplexer(transport)
  state.mux = mux
  wireWslRelayLink({
    mux,
    child,
    distro: state.distro,
    ingest: deps.ingest,
    warn: deps.warn,
    onDead: (reason) => {
      if (isDisposed() || state.mux !== mux) {
        return
      }
      state.mux = undefined
      const wasRunning = state.phase === 'running'
      if (
        wasRunning &&
        state.connectedAt !== undefined &&
        Date.now() - state.connectedAt >= 120_000
      ) {
        state.failures = 0
      }
      markFailed(
        state,
        `relay link for '${state.distro}' ${reason}; scheduling restart`,
        wasRunning ? 10_000 : 60_000
      )
    }
  })
  const homeResult = (await mux.request(WSL_HOOK_FS_METHODS.home)) as {
    ok?: boolean
    home?: string
    portFallback?: boolean
    boundPort?: number
  }
  if (homeResult?.ok !== true || typeof homeResult.home !== 'string') {
    throw new Error(`relay for '${state.distro}' returned no home dir`)
  }
  if (homeResult.portFallback === true) {
    deps.warn(
      `[agent-hooks] WSL hook relay (${state.distro}): preferred port occupied in guest; bound ${homeResult.boundPort ?? 'unknown'} (endpoint-file re-coordination)`
    )
  }
  state.guestHome = homeResult.home
  state.guestEndpointFilePath = wslHookRelayEndpointFilePath(homeResult.home, instanceKey)
  if (isWslRelayHooksAllowed(deps)) {
    await runWslRelayGuestInstall(deps, state, mux, homeResult.home)
  }
  if (state.phase === 'failed' || state.mux !== mux) {
    return
  }
  state.phase = 'running'
  state.connectedAt = Date.now()
  recovery.scheduleOneShotReinstall(state, 60_000, () => {
    void maybeRerunWslRelayGuestInstall(deps, state)
  })
  if (isWslRelayHooksAllowed(deps)) {
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch(() => undefined)
  }
}

export function markWslRelayFailed(
  state: WslRelayState,
  deps: WslHookRelayManagerDeps,
  recovery: WslRelayRecovery,
  message: string,
  cooldownBaseMs: number
): void {
  state.phase = 'failed'
  state.failures++
  state.child = undefined
  state.mux = undefined
  if (state.reinstallTimer) {
    clearTimeout(state.reinstallTimer)
    state.reinstallTimer = undefined
  }
  state.cooldownUntil = Date.now() + Math.min(cooldownBaseMs * state.failures, 10 * 60_000)
  deps.warn(`[agent-hooks] WSL hook relay (${state.distro}): ${message}`)
  recovery.scheduleRestart(state)
}

export function resumeWslRelayStates(
  stopped: Map<string, string | undefined>,
  isRunning: (distro: string) => Promise<boolean>,
  ensure: (distro: string, home?: string) => void
): void {
  const distros = [...stopped]
  stopped.clear()
  for (const [distro, home] of distros) {
    void isRunning(distro)
      .then((running) => {
        if (running) {
          ensure(distro, home)
        }
      })
      .catch(() => undefined)
  }
}

export function disposeWslRelayStates(
  states: Map<string, WslRelayState>,
  recovery: WslRelayRecovery,
  stopped: Map<string, string | undefined>,
  permanent: boolean
): void {
  for (const state of states.values()) {
    recovery.clearTimers(state)
    state.mux?.dispose()
    state.child?.kill()
    if (!permanent) {
      stopped.set(state.distro, state.codexHomePath)
    }
  }
  states.clear()
}

export async function resolveWslRelayDefaultDistro(
  current: string | null,
  list: () => Promise<string[]>
): Promise<string | null> {
  if (current) {
    return current
  }
  try {
    return (await list())[0] ?? null
  } catch {
    return null
  }
}
