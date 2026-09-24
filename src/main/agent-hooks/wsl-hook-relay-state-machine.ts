import { FAILURE_COOLDOWN_MAX_MS } from './wsl-hook-relay-deps'

type RelayFailureState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  failures: number
  cooldownUntil: number
  child?: unknown
  mux?: { dispose(): void }
  reinstallTimer?: ReturnType<typeof setTimeout>
}

type RelayFailureDeps = {
  warn(message: string): void
}

type RelayRecovery = {
  scheduleRestart(state: RelayFailureState): void
}

export function markWslRelayFailed(
  state: RelayFailureState,
  message: string,
  options: { cooldownBaseMs: number },
  deps: RelayFailureDeps,
  recovery: RelayRecovery
): void {
  state.phase = 'failed'
  state.failures++
  state.child = undefined
  state.mux = undefined
  if (state.reinstallTimer) {
    clearTimeout(state.reinstallTimer)
    state.reinstallTimer = undefined
  }
  state.cooldownUntil =
    Date.now() + Math.min(options.cooldownBaseMs * state.failures, FAILURE_COOLDOWN_MAX_MS)
  deps.warn(`[agent-hooks] WSL hook relay: ${message}`)
  recovery.scheduleRestart(state)
}

export function resumeWslStoppedRelays(
  stopped: Map<string, string | undefined>,
  isDistroRunning: (distro: string) => Promise<boolean>,
  ensure: (distro: string, home: string | undefined) => void
): void {
  const distros = [...stopped]
  stopped.clear()
  for (const [distro, home] of distros) {
    void isDistroRunning(distro)
      .then((running) => {
        if (running) {
          ensure(distro, home)
        }
      })
      .catch(() => undefined)
  }
}

export async function resolveWslDefaultDistro(
  current: string | null,
  listDistros: () => Promise<string[]>
): Promise<string | null> {
  if (current) {
    return current
  }
  try {
    return (await listDistros())[0] ?? null
  } catch {
    return null
  }
}
