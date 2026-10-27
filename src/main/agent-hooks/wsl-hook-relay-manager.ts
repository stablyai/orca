import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  runWslRelayGuestInstall,
  maybeRerunWslRelayGuestInstall
} from './wsl-hook-relay-guest-install'
import { buildWslRelaySpawnEnv, launchWslRelayWithInstall } from './wsl-hook-relay-launch'
import {
  defaultWslHookRelayDeps,
  isWslHookRelayAllowed,
  FAILURE_COOLDOWN_BASE_MS,
  NO_NODE_COOLDOWN_MS,
  REINSTALL_ONE_SHOT_DELAY_MS,
  RUNNING_TEARDOWN_COOLDOWN_MS,
  STABLE_UPTIME_MS,
  type WslHookRelayManagerDeps
} from './wsl-hook-relay-deps'
import { wireWslRelayLink } from './wsl-hook-relay-link'
import type { WslRelayRecovery } from './wsl-hook-relay-recovery'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_REQUEST_REPLAY_METHOD } from '../../shared/agent-hook-relay'
import {
  sanitizeWslHookInstanceKey,
  WSL_HOOK_FS_METHODS,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'
import {
  recordManagedWslCodexHome,
  wslRuntimeHomePathsEqual
} from '../codex/managed-wsl-codex-home-registry'
import {
  createWslRelayRecoveryForManager,
  markWslRelayFailed,
  resolveWslDefaultDistro,
  resumeWslStoppedRelays
} from './wsl-hook-relay-state-machine'
import type { WslRelayDistroState } from './wsl-hook-relay-state'
export class WslHookRelayManager {
  private deps: WslHookRelayManagerDeps
  private recovery: WslRelayRecovery
  private states = new Map<string, WslRelayDistroState>()
  private stoppedByHooksOff = new Map<string, string | undefined>()
  private defaultDistro: string | null = null
  private disposed = false
  private warnedBundleMissing = false
  constructor(deps: Partial<WslHookRelayManagerDeps> = {}) {
    this.deps = { ...defaultWslHookRelayDeps, ...deps }
    this.recovery = createWslRelayRecoveryForManager({
      deps: () => this.deps,
      states: this.states,
      isDisposed: () => this.disposed,
      ensure: (...args) => this.ensureForDistro(...args)
    })
  }
  setManagedHookSettingsResolver(resolve: WslHookRelayManagerDeps['managedHookSettings']): void {
    this.deps.managedHookSettings = resolve
  }
  async ensureForDistro(
    distro: string | null,
    codexHomePath?: string | null,
    launchKind?: 'pi' | 'omp'
  ): Promise<void> {
    if (this.disposed || !isWslHookRelayAllowed(this.deps)) {
      return
    }
    await this.ensureInternal(distro, codexHomePath ?? undefined, launchKind).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err)
      this.deps.warn(`[agent-hooks] WSL hook relay ensure failed: ${detail}`)
    })
  }
  private stateFor(distro: string | null): WslRelayDistroState | undefined {
    return this.states.get(wslHookRelayStateKey(distro ?? this.defaultDistro ?? ''))
  }
  getGuestEndpointFilePath(distro: string | null): string | null {
    return this.stateFor(distro)?.connectedAt
      ? (this.stateFor(distro)?.guestEndpointFilePath ?? null)
      : null
  }
  getClaudeAgentView(distro: string | null): { pluginDir: string; configDir: string } | null {
    const state = this.stateFor(distro)
    return state?.claudeAgentViewDir && state.claudeConfigDir
      ? { pluginDir: state.claudeAgentViewDir, configDir: state.claudeConfigDir }
      : null
  }
  getOpenCodeOverlayDir(
    distro: string | null,
    agent: 'opencode' | 'opencode2' = 'opencode'
  ): string | null {
    const state = this.stateFor(distro)
    return agent === 'opencode2'
      ? (state?.opencode2OverlayDir ?? null)
      : (state?.opencodeOverlayDir ?? null)
  }
  getGuestAgentPath(distro: string | null, kind: 'pi' | 'omp'): string | null {
    const state = this.stateFor(distro)
    return kind === 'pi' ? (state?.piAgentDir ?? null) : (state?.ompStatusExtension ?? null)
  }
  /** Nonpermanent disposal allows relays to restart when hooks are re-enabled. */
  disposeAll({ permanent = true }: { permanent?: boolean } = {}): void {
    this.disposed ||= permanent
    for (const state of this.states.values()) {
      this.recovery.clearTimers(state)
      state.mux?.dispose()
      state.child?.kill()
      if (!permanent) {
        this.stoppedByHooksOff.set(state.distro, state.codexHomePath)
      }
    }
    this.states.clear()
  }
  /** Resume only running distros: wsl -d would boot one the user shut down. */
  resumeStoppedRelays(): void {
    resumeWslStoppedRelays(this.stoppedByHooksOff, this.deps.isDistroRunning, (distro, home) =>
      this.ensureForDistro(distro, home)
    )
  }
  private async ensureInternal(
    requestedDistro: string | null,
    requestedCodexHomePath?: string,
    launchKind?: 'pi' | 'omp'
  ): Promise<void> {
    const distro = requestedDistro ?? (await this.resolveDefaultDistro())
    if (!distro || this.disposed) {
      return
    }
    const key = wslHookRelayStateKey(distro)
    const existing = this.states.get(key)
    if (requestedCodexHomePath) {
      recordManagedWslCodexHome(distro, requestedCodexHomePath)
    }
    if (existing) {
      if (launchKind && !existing.launchKinds.has(launchKind)) {
        existing.launchKinds.add(launchKind)
        existing.lastInstallAt = 0
      }
      if (
        requestedCodexHomePath &&
        !wslRuntimeHomePathsEqual(existing.codexHomePath, requestedCodexHomePath)
      ) {
        existing.codexHomePath = requestedCodexHomePath
        existing.lastInstallAt = 0
      }
      if (existing.phase === 'running') {
        await maybeRerunWslRelayGuestInstall(this.deps, existing)
        return
      }
      if (existing.phase !== 'failed' || Date.now() < existing.cooldownUntil) {
        await existing.startup
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
        this.deps.warn('[agent-hooks] WSL hook relay bundle not found; run build:wsl-guest')
      }
      return
    }
    const instanceKey =
      sanitizeWslHookInstanceKey(this.deps.instanceKey() ?? undefined) ?? `port${port}`
    if (existing) {
      this.recovery.clearTimers(existing)
    }
    const state: WslRelayDistroState = {
      distro,
      phase: 'starting',
      failures: existing?.failures ?? 0,
      claudeAgentViewDir: existing?.claudeAgentViewDir,
      claudeConfigDir: existing?.claudeConfigDir,
      opencodeOverlayDir: existing?.opencodeOverlayDir,
      opencode2OverlayDir: existing?.opencode2OverlayDir,
      piAgentDir: existing?.piAgentDir,
      ompStatusExtension: existing?.ompStatusExtension,
      launchKinds: new Set(existing?.launchKinds ?? (launchKind ? [launchKind] : [])),
      codexHomePath: requestedCodexHomePath ?? existing?.codexHomePath,
      cooldownUntil: 0
    }
    this.states.set(key, state)
    const env = buildWslRelaySpawnEnv(coords, bundle.version, instanceKey)
    state.startup = launchWslRelayWithInstall({
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
          `no node >= 18 found in distro '${state.distro}'; agent hooks stay degraded there`,
          { cooldownBaseMs: NO_NODE_COOLDOWN_MS }
        ),
      onFailure: (message) =>
        this.markFailed(state, message, {
          cooldownBaseMs: FAILURE_COOLDOWN_BASE_MS
        }),
      connect: (transport, child) => this.connect(state, transport, child, instanceKey)
    }).catch((err) => {
      state.child?.kill()
      state.mux?.dispose()
      if (state.phase !== 'failed') {
        this.markFailed(state, err instanceof Error ? err.message : String(err), {
          cooldownBaseMs: FAILURE_COOLDOWN_BASE_MS
        })
      }
    })
    await state.startup
  }
  private async connect(
    state: WslRelayDistroState,
    transport: MultiplexerTransport,
    child: ChildProcessWithoutNullStreams,
    instanceKey: string
  ): Promise<void> {
    const mux = new SshChannelMultiplexer(transport)
    state.mux = mux
    wireWslRelayLink({
      bindInterruptReconciliation: this.deps.bindInterruptReconciliation,
      mux,
      child,
      distro: state.distro,
      ingest: this.deps.ingest,
      receiveClaudeAgentView: (body) =>
        isWslHookRelayAllowed(this.deps) ? (this.deps.receiveClaudeAgentView?.(body) ?? {}) : {},
      warn: this.deps.warn,
      onDead: (reason) => {
        if (this.disposed || state.mux !== mux) {
          return
        }
        state.mux = undefined
        const wasRunning = state.phase === 'running'
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
    await runWslRelayGuestInstall(this.deps, state, mux, homeResult.home)
    if (state.phase === 'failed' || state.mux !== mux) {
      return
    }
    state.phase = 'running'
    state.connectedAt = Date.now()
    this.recovery.scheduleOneShotReinstall(state, REINSTALL_ONE_SHOT_DELAY_MS, () => {
      void maybeRerunWslRelayGuestInstall(this.deps, state)
    })
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch(() => {})
  }
  /** Keep retrying failed relaunches while distro-running checks prevent unwanted VM starts. */
  private markFailed(
    state: WslRelayDistroState,
    message: string,
    options: { cooldownBaseMs: number }
  ): void {
    markWslRelayFailed(state, message, options, this.deps, this.recovery)
  }
  private async resolveDefaultDistro(): Promise<string | null> {
    const distro = await resolveWslDefaultDistro(this.defaultDistro, this.deps.listDistros)
    this.defaultDistro = distro
    return distro
  }
}
export const wslHookRelayManager = new WslHookRelayManager()
