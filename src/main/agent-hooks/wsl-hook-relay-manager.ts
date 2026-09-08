// Host-side lifecycle manager for the resident WSL relay.
import { maybeRerunWslRelayGuestInstall } from './wsl-hook-relay-guest-install'
import { buildWslRelaySpawnEnv, launchWslRelayWithInstall } from './wsl-hook-relay-launch'
import {
  defaultWslHookRelayDeps,
  isWslRelayAllowed,
  isWslRelayHooksAllowed,
  FAILURE_COOLDOWN_BASE_MS,
  FAILURE_COOLDOWN_MAX_MS,
  NO_NODE_COOLDOWN_MS,
  type WslHookRelayManagerDeps
} from './wsl-hook-relay-deps'
import { WslRelayRecovery } from './wsl-hook-relay-recovery'
import {
  connectWslRelayState,
  disposeWslRelayStates,
  resolveWslRelayDefaultDistro,
  resumeWslRelayStates,
  type WslRelayState
} from './wsl-hook-relay-lifecycle'
import {
  readWslRelayProcessIdentity,
  resetWslRelayIdentityRpcCount as resetIdentityCounter,
  wslRelayIdentityRpcCount
} from './wsl-hook-relay-identity'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import {
  getWslRelayGuestHookInstallCount,
  resetWslRelayGuestHookInstallCount
} from './wsl-hook-relay-guest-install'
import {
  sanitizeWslHookInstanceKey,
  WSL_RELAY_HOOKS_SET_ENABLED_METHOD
} from '../../shared/wsl-hook-relay-contract'
import {
  recordManagedWslCodexHome,
  wslRuntimeHomePathsEqual
} from '../codex/managed-wsl-codex-home-registry'

type DistroState = WslRelayState
type EnsureOptions = { skipGuestInstall?: boolean }

export function getWslRelayIdentityRpcCount(): number {
  return wslRelayIdentityRpcCount
}

export function resetWslRelayIdentityRpcCount(): void {
  resetIdentityCounter()
}

export { getWslRelayGuestHookInstallCount, resetWslRelayGuestHookInstallCount }

export class WslHookRelayManager {
  private deps: WslHookRelayManagerDeps
  private recovery: WslRelayRecovery
  private states = new Map<string, DistroState>()
  private stoppedByHooksOff = new Map<string, string | undefined>()
  private defaultDistro: string | null = null
  private disposed = false
  private warnedBundleMissing = false
  private ensurePromises = new Map<string, Promise<void>>()

  constructor(deps: Partial<WslHookRelayManagerDeps> = {}) {
    this.deps = { ...defaultWslHookRelayDeps, ...deps }
    this.recovery = new WslRelayRecovery({
      isDistroRunning: (distro) => this.deps.isDistroRunning(distro),
      warn: (message) => this.deps.warn(message),
      isDisposed: () => this.disposed,
      isCurrent: (state) => this.states.get(wslHookRelayStateKey(state.distro)) === state,
      restart: (distro) => this.ensureForDistro(distro, this.stateFor(distro)?.codexHomePath),
      dropState: (state) => {
        const key = wslHookRelayStateKey(state.distro)
        if (this.states.get(key) === state) {
          this.states.delete(key)
        }
      }
    })
  }

  setManagedHookSettingsResolver(resolve: WslHookRelayManagerDeps['managedHookSettings']): void {
    this.deps.managedHookSettings = resolve
    this.refreshHookCapability()
  }

  refreshHookCapability(): void {
    const enabled = isWslRelayHooksAllowed(this.deps)
    for (const state of this.states.values()) {
      if (state.phase !== 'running' || !state.mux || state.mux.isDisposed()) {
        continue
      }
      void state.mux
        .request(WSL_RELAY_HOOKS_SET_ENABLED_METHOD, { enabled }, { timeoutMs: 5_000 })
        .then(() => {
          if (enabled) {
            void maybeRerunWslRelayGuestInstall(this.deps, state)
          }
        })
        .catch(() => undefined)
    }
  }

  ensureForDistro(distro: string | null, codexHomePath?: string | null): void {
    void this.ensureForDistroAsync(distro, codexHomePath)
  }

  private ensureForDistroAsync(
    distro: string | null,
    codexHomePath?: string | null,
    options: EnsureOptions = {}
  ): Promise<void> {
    if (
      this.disposed ||
      this.deps.platform() !== 'win32' ||
      (distro !== null && !isWslRelayAllowed(this.deps, distro))
    ) {
      return Promise.resolve()
    }
    const key = distro?.trim().toLowerCase() ?? '__all__'
    const prior = this.ensurePromises.get(key)
    if (prior) {
      return prior
    }
    const pending = (
      distro === null
        ? this.deps.listDistros().then((distros) =>
            Promise.all(
              distros.map((candidate) =>
                this.ensureForDistroAsync(candidate, codexHomePath, options)
              )
            ).then(() => {
              this.defaultDistro ||= distros[0] ?? null
            })
          )
        : this.ensureInternal(distro, codexHomePath ?? undefined, options)
    )
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.deps.warn(`[agent-hooks] WSL relay ensure failed: ${detail}`)
      })
      .finally(() => {
        if (this.ensurePromises.get(key) === pending) {
          this.ensurePromises.delete(key)
        }
      })
    this.ensurePromises.set(key, pending)
    return pending
  }

  private stateFor(distro: string | null): DistroState | undefined {
    return this.states.get(wslHookRelayStateKey(distro ?? this.defaultDistro ?? ''))
  }

  getGuestEndpointFilePath(distro: string | null): string | null {
    return this.stateFor(distro)?.guestEndpointFilePath ?? null
  }

  getOpenCodeOverlayDir(distro: string | null): string | null {
    return this.stateFor(distro)?.opencodeOverlayDir ?? null
  }

  readProcessIdentity = (
    distro: string,
    anchors: Parameters<typeof readWslRelayProcessIdentity>[0]['anchors'],
    options?: { signal?: AbortSignal; timeoutMs?: number; stableUntilReset?: boolean }
  ) =>
    readWslRelayProcessIdentity({
      distro,
      anchors,
      deps: this.deps,
      // A process-identity read may need to start a missing relay, but must not
      // turn every read into a hook/plugin reinstall on an already-running one.
      ensure: (target) => this.ensureForDistroAsync(target, undefined, { skipGuestInstall: true }),
      getState: (target) => this.stateFor(target),
      disposed: this.disposed,
      requestOptions: options
    })

  disposeAll({ permanent = true }: { permanent?: boolean } = {}): void {
    this.disposed ||= permanent
    disposeWslRelayStates(this.states, this.recovery, this.stoppedByHooksOff, permanent)
  }

  resumeStoppedRelays(): void {
    resumeWslRelayStates(this.stoppedByHooksOff, this.deps.isDistroRunning, (distro, home) =>
      this.ensureForDistro(distro, home)
    )
  }

  private async ensureInternal(
    requestedDistro: string | null,
    requestedCodexHomePath?: string,
    options: EnsureOptions = {}
  ): Promise<void> {
    const distro =
      requestedDistro ??
      (await resolveWslRelayDefaultDistro(this.defaultDistro, this.deps.listDistros))
    if (!distro || this.disposed) {
      return
    }
    if (!requestedDistro) {
      this.defaultDistro = distro
    }
    const key = wslHookRelayStateKey(distro)
    const existing = this.states.get(key)
    if (requestedCodexHomePath) {
      recordManagedWslCodexHome(distro, requestedCodexHomePath)
    }
    if (existing) {
      if (
        requestedCodexHomePath &&
        !wslRuntimeHomePathsEqual(existing.codexHomePath, requestedCodexHomePath)
      ) {
        existing.codexHomePath = requestedCodexHomePath
        existing.lastInstallAt = 0
      }
      if (existing.phase === 'running') {
        if (!options.skipGuestInstall) {
          void maybeRerunWslRelayGuestInstall(this.deps, existing)
        }
        return
      }
      if (existing.phase !== 'failed' || Date.now() < existing.cooldownUntil) {
        return
      }
    }
    const coords = this.deps.hookCoordsEnv()
    const port = Number(coords.ORCA_AGENT_HOOK_PORT ?? '')
    const bundle = this.deps.resolveBundle()
    if (!bundle) {
      if (!this.warnedBundleMissing) {
        this.warnedBundleMissing = true
        this.deps.warn('[agent-hooks] WSL hook relay bundle not found; run build:relay')
      }
      return
    }
    const instanceKey =
      sanitizeWslHookInstanceKey(this.deps.instanceKey() ?? undefined) ?? `port${port}`
    if (existing) {
      this.recovery.clearTimers(existing)
    }
    const state: DistroState = {
      distro,
      phase: 'starting',
      failures: existing?.failures ?? 0,
      opencodeOverlayDir: existing?.opencodeOverlayDir,
      codexHomePath: requestedCodexHomePath ?? existing?.codexHomePath,
      cooldownUntil: 0
    }
    this.states.set(key, state)

    const env = buildWslRelaySpawnEnv(
      coords,
      bundle.version,
      instanceKey,
      state.distro,
      isWslRelayHooksAllowed(this.deps)
    )

    try {
      await launchWslRelayWithInstall({
        distro: state.distro,
        env,
        bundleJsPath: bundle.jsPath,
        version: bundle.version,
        io: this.deps,
        isDisposed: () => this.disposed || this.states.get(key) !== state,
        onChild: (child) => {
          state.child = child
        },
        onNoNode: () =>
          this.markFailed(
            state,
            `no node >= 18 found in distro '${state.distro}'; relay capabilities stay degraded there`,
            { cooldownBaseMs: NO_NODE_COOLDOWN_MS }
          ),
        onFailure: (message) =>
          this.markFailed(state, message, {
            cooldownBaseMs: FAILURE_COOLDOWN_BASE_MS
          }),
        connect: (transport, child) =>
          connectWslRelayState({
            state,
            transport,
            child,
            instanceKey,
            deps: this.deps,
            recovery: this.recovery,
            isDisposed: () => this.disposed || this.states.get(key) !== state,
            markFailed: (target, message, cooldownBaseMs) =>
              this.markFailed(target, message, { cooldownBaseMs })
          })
      })
    } catch (err) {
      state.child?.kill()
      state.mux?.dispose()
      if (state.phase !== 'failed') {
        this.markFailed(state, err instanceof Error ? err.message : String(err), {
          cooldownBaseMs: FAILURE_COOLDOWN_BASE_MS
        })
      }
    }
  }

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
}

export const wslHookRelayManager = new WslHookRelayManager()
