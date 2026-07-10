// Host-side lifecycle manager for the guest-resident WSL agent-hook relay
// (STA-1515): one relay per distro per instance, ensured from every WSL PTY
// spawn, forwarding envelopes into ingestRemote and installing guest hooks.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { installWslGuestHooks } from './wsl-hook-fs-adapter'
import { buildWslRelaySpawnEnv, launchWslRelayWithInstall } from './wsl-hook-relay-launch'
import {
  defaultWslHookRelayDeps,
  FAILURE_COOLDOWN_BASE_MS,
  FAILURE_COOLDOWN_MAX_MS,
  NO_NODE_COOLDOWN_MS,
  REINSTALL_MIN_INTERVAL_MS,
  REINSTALL_ONE_SHOT_DELAY_MS,
  RUNNING_TEARDOWN_COOLDOWN_MS,
  STABLE_UPTIME_MS,
  type WslHookRelayManagerDeps
} from './wsl-hook-relay-deps'
import { wireWslRelayLink } from './wsl-hook-relay-link'
import { WslRelayRecovery } from './wsl-hook-relay-recovery'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_REQUEST_REPLAY_METHOD } from '../../shared/agent-hook-relay'
import {
  sanitizeWslHookInstanceKey,
  WSL_HOOK_FS_METHODS,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'

type DistroState = {
  /** Original casing for wsl.exe argv and breadcrumbs; map keys are lowercased. */
  distro: string
  phase: 'starting' | 'running' | 'failed'
  child?: ChildProcessWithoutNullStreams
  mux?: SshChannelMultiplexer
  guestHome?: string
  guestEndpointFilePath?: string
  failures: number
  cooldownUntil: number
  connectedAt?: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
  lastInstallAt?: number
}

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export class WslHookRelayManager {
  private deps: WslHookRelayManagerDeps
  private recovery: WslRelayRecovery
  private states = new Map<string, DistroState>()
  private defaultDistro: string | null = null
  private disposed = false
  private warnedBundleMissing = false

  constructor(deps: Partial<WslHookRelayManagerDeps> = {}) {
    this.deps = { ...defaultWslHookRelayDeps, ...deps }
    this.recovery = new WslRelayRecovery({
      isDistroRunning: (distro) => this.deps.isDistroRunning(distro),
      warn: (message) => this.deps.warn(message),
      isDisposed: () => this.disposed,
      isCurrent: (state) => this.states.get(distroKey(state.distro)) === state,
      restart: (distro) => this.ensureForDistro(distro),
      dropState: (state) => {
        // Why: identity-guarded — a fresh ensure() may own this key by now;
        // deleting by key alone would orphan its live relay child.
        const key = distroKey(state.distro)
        if (this.states.get(key) === state) {
          this.states.delete(key)
        }
      }
    })
  }

  /** Fire-and-forget from every WSL PTY spawn-env build; errors breadcrumb. */
  ensureForDistro(distro: string | null): void {
    if (this.disposed || this.deps.platform() !== 'win32' || !this.deps.remoteHooksEnabled()) {
      return
    }
    void this.ensureInternal(distro).catch((err) => {
      this.deps.warn(
        `[agent-hooks] WSL hook relay ensure failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  /** Guest endpoint file path once known; null before first connect
   *  (callers keep the /p-translated Windows endpoint path until then). */
  getGuestEndpointFilePath(distro: string | null): string | null {
    const name = distro ?? this.defaultDistro
    if (!name) {
      return null
    }
    return this.states.get(distroKey(name))?.guestEndpointFilePath ?? null
  }

  disposeAll(): void {
    this.disposed = true
    for (const state of this.states.values()) {
      this.recovery.clearTimers(state)
      state.mux?.dispose()
      state.child?.kill()
    }
    this.states.clear()
  }

  private async ensureInternal(requestedDistro: string | null): Promise<void> {
    const distro = requestedDistro ?? (await this.resolveDefaultDistro())
    if (!distro || this.disposed) {
      return
    }
    const key = distroKey(distro)
    const existing = this.states.get(key)
    if (existing) {
      if (existing.phase === 'running') {
        void this.maybeReinstallHooks(existing)
        return
      }
      if (existing.phase !== 'failed' || Date.now() < existing.cooldownUntil) {
        return
      }
    }
    const coords = this.deps.hookCoordsEnv()
    const port = Number(coords.ORCA_AGENT_HOOK_PORT ?? '')
    if (!Number.isInteger(port) || port <= 0 || !coords.ORCA_AGENT_HOOK_TOKEN) {
      return
    }
    const bundle = this.deps.resolveBundle()
    if (!bundle) {
      if (!this.warnedBundleMissing) {
        this.warnedBundleMissing = true
        this.deps.warn('[agent-hooks] WSL hook relay bundle not found; run build:relay')
      }
      return
    }
    // Why: restart-stable instance identity keeps the guest endpoint file at
    // ONE path across restarts so daemon-surviving agents re-coordinate.
    const instanceKey =
      sanitizeWslHookInstanceKey(this.deps.instanceKey() ?? undefined) ?? `port${port}`
    if (existing) {
      this.recovery.clearTimers(existing)
    }
    const state: DistroState = {
      distro,
      phase: 'starting',
      failures: existing?.failures ?? 0,
      cooldownUntil: 0
    }
    this.states.set(key, state)

    const env = buildWslRelaySpawnEnv(coords, bundle.version, instanceKey)

    try {
      await launchWslRelayWithInstall({
        distro: state.distro,
        env,
        bundleJsPath: bundle.jsPath,
        version: bundle.version,
        io: this.deps,
        isDisposed: () => this.disposed,
        onChild: (child) => {
          state.child = child
        },
        onNoNode: () =>
          this.markFailed(
            state,
            `no node >= 18 found in distro '${state.distro}'; agent hooks stay degraded there`,
            { cooldownBaseMs: NO_NODE_COOLDOWN_MS }
          ),
        onFailure: (message) =>
          this.markFailed(state, message, { cooldownBaseMs: FAILURE_COOLDOWN_BASE_MS }),
        connect: (transport, child) => this.connect(state, transport, child, instanceKey)
      })
    } catch (err) {
      // Why: teardown may have already recorded this failure; don't double-
      // count. A request-level error can leave a live child — never leak it.
      state.child?.kill()
      state.mux?.dispose()
      if (state.phase !== 'failed') {
        this.markFailed(state, err instanceof Error ? err.message : String(err), {
          cooldownBaseMs: FAILURE_COOLDOWN_BASE_MS
        })
      }
    }
  }

  private async connect(
    state: DistroState,
    transport: MultiplexerTransport,
    child: ChildProcessWithoutNullStreams,
    instanceKey: string
  ): Promise<void> {
    const mux = new SshChannelMultiplexer(transport)
    state.mux = mux
    wireWslRelayLink({
      mux,
      child,
      distro: state.distro,
      ingest: this.deps.ingest,
      warn: this.deps.warn,
      onDead: (reason) => {
        if (this.disposed || state.mux !== mux) {
          return
        }
        state.mux = undefined
        const wasRunning = state.phase === 'running'
        // Why: only a stable run forgives past failures — a connect-then-die
        // loop must escalate, not retry every 10s.
        if (
          wasRunning &&
          state.connectedAt !== undefined &&
          Date.now() - state.connectedAt >= STABLE_UPTIME_MS
        ) {
          state.failures = 0
        }
        this.markFailed(state, `relay link for '${state.distro}' ${reason}; scheduling restart`, {
          cooldownBaseMs: wasRunning ? RUNNING_TEARDOWN_COOLDOWN_MS : FAILURE_COOLDOWN_BASE_MS
        })
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
      this.deps.warn(
        `[agent-hooks] WSL hook relay (${state.distro}): preferred port occupied in guest; bound ${homeResult.boundPort ?? 'unknown'} (endpoint-file re-coordination)`
      )
    }
    state.guestHome = homeResult.home
    state.guestEndpointFilePath = wslHookRelayEndpointFilePath(homeResult.home, instanceKey)
    await this.runInstallers(state, mux, homeResult.home)

    if (state.phase === 'failed' || state.mux !== mux) {
      // Child died while installing — already recorded; don't revive.
      return
    }
    state.phase = 'running'
    state.connectedAt = Date.now()
    // Why: one-shot catch-up so a single-spawn session (no later ensure)
    // still writes Codex's deferred trust after the launch path seeds config.toml.
    this.recovery.scheduleOneShotReinstall(state, REINSTALL_ONE_SHOT_DELAY_MS, () => {
      void this.maybeReinstallHooks(state)
    })
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch(() => {
      // Fresh relays have nothing to replay; tolerate.
    })
  }

  private async runInstallers(
    state: DistroState,
    mux: SshChannelMultiplexer,
    guestHome: string
  ): Promise<void> {
    state.lastInstallAt = Date.now()
    await installWslGuestHooks({
      mux,
      guestHome,
      distro: state.distro,
      installHooks: this.deps.installHooks,
      warn: this.deps.warn
    })
  }

  private async maybeReinstallHooks(state: DistroState): Promise<void> {
    const mux = state.mux
    const guestHome = state.guestHome
    if (
      !mux ||
      !guestHome ||
      mux.isDisposed() ||
      Date.now() - (state.lastInstallAt ?? 0) < REINSTALL_MIN_INTERVAL_MS
    ) {
      return
    }
    try {
      await this.runInstallers(state, mux, guestHome)
    } catch (err) {
      this.deps.warn(
        `[agent-hooks] WSL hook reinstall for '${state.distro}' failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** Records + breadcrumbs the failure and always arms the restart timer —
   *  one failed relaunch must not end self-recovery; the timer's
   *  distro-running probe keeps this from booting stopped distros. */
  private markFailed(
    state: DistroState,
    message: string,
    options: { cooldownBaseMs: number }
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
    this.deps.warn(`[agent-hooks] WSL hook relay (${state.distro}): ${message}`)
    this.recovery.scheduleRestart(state)
  }

  private async resolveDefaultDistro(): Promise<string | null> {
    if (this.defaultDistro) {
      return this.defaultDistro
    }
    try {
      const distros = await this.deps.listDistros()
      this.defaultDistro = distros[0] ?? null
    } catch {
      this.defaultDistro = null
    }
    return this.defaultDistro
  }
}

export const wslHookRelayManager = new WslHookRelayManager()
