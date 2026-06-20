/* oxlint-disable max-lines */
// Why: consolidates all relay lifecycle state (multiplexer, providers, abort
// controller, initialization flag) into a single class per SSH target.
// Previously this state was scattered across 5 module-level Maps/Sets in
// ssh.ts and ssh-relay-helpers.ts, with 3 separate code paths for initial
// connect, network-blip reconnect, and cleanup — each partially duplicating
// provider registration/teardown logic. This class is the single authority
// for relay session state, eliminating the class of bugs where one path
// forgets a step that another path handles.

import type { BrowserWindow } from 'electron'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isRelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import type { RelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshPtyProvider, isSshPtyNotFoundError } from '../providers/ssh-pty-provider'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshGitProvider } from '../providers/ssh-git-provider'
import { agentHookServer } from '../agent-hooks/server'
import { installRemoteManagedAgentHooks } from '../agent-hooks/remote-managed-hook-installers'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD,
  isRemoteAgentHooksEnabled
} from '../../shared/agent-hook-relay'
import { _internals as openCodeInternals } from '../opencode/hook-service'
import { getPiAgentStatusExtensionSource } from '../pi/agent-status-extension-source'
import {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  setPtyOwnership
} from '../ipc/pty'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { notifyRemoteWorkspaceHandlers } from '../ipc/remote-workspace-events'
import { PortScanner } from './ssh-port-scanner'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import { joinRemotePath, isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { makeRemoteDirectoryCommand, makeRemoteExecutableCommand } from './ssh-remote-commands'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type DetectedPort,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../../shared/ssh-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

export type RelaySessionState = 'idle' | 'deploying' | 'ready' | 'reconnecting' | 'disposed'

type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  hostPlatform: RemoteHostPlatform
  pathDelimiter?: ':' | ';'
}

function normalizeRelayGracePeriodSeconds(graceTimeSeconds: number | undefined): number {
  const raw = graceTimeSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  const requested = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  return requested === 0
    ? 0
    : Math.max(
        MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        Math.min(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, requested)
      )
}

export class SshRelaySession {
  private _state: RelaySessionState = 'idle'
  private mux: SshChannelMultiplexer | null = null
  private abortController: AbortController | null = null
  private muxDisposeCleanup: (() => void) | null = null
  // Why: store the notification-handler disposer so teardownProviders can
  // release it on reconnect/shutdown. Symmetric with muxDisposeCleanup; while
  // the old mux's handler array is GC'd along with the mux today, holding the
  // disposer is cheap insurance against future code that retains the old mux.
  private muxNotificationCleanup: (() => void) | null = null
  // Why: when the relay exec channel closes but the SSH connection stays
  // up, the onStateChange reconnect path never fires. This callback lets
  // ssh.ts wire up relay-level reconnect from outside the session.
  private _onRelayLost: ((targetId: string) => void) | null = null
  // Why: a wire-handshake mismatch is terminal — the daemon and client are at
  // different versions, no amount of backoff retry will reconcile them. This
  // separate callback lets ssh.ts surface the failure to the user and skip
  // the relay-lost backoff loop entirely. Distinct from _onRelayLost because
  // _onRelayLost expects a recoverable transport drop.
  private _onTerminalRelayError:
    | ((targetId: string, err: RelayVersionMismatchError) => void)
    | null = null
  private _onReady: ((targetId: string) => void) | null = null
  private portScanner: PortScanner | null = null
  private currentConnection: SshConnection | null = null
  private hostPlatform: RemoteHostPlatform | null = null
  private remoteCliBridgeEnv: RemoteCliBridgeEnv | null = null

  constructor(
    readonly targetId: string,
    private getMainWindow: () => BrowserWindow | null,
    private store: Store,
    private portForwardManager: SshPortForwardManager,
    private runtime?: OrcaRuntimeService,
    private onDetectedPortsChanged?: (
      targetId: string,
      ports: DetectedPort[],
      platform: string
    ) => void
  ) {}

  refreshEnvironment(
    getMainWindow: () => BrowserWindow | null,
    store: Store,
    portForwardManager: SshPortForwardManager,
    runtime?: OrcaRuntimeService,
    onDetectedPortsChanged?: (targetId: string, ports: DetectedPort[], platform: string) => void
  ): void {
    this.getMainWindow = getMainWindow
    this.store = store
    this.portForwardManager = portForwardManager
    this.runtime = runtime
    this.onDetectedPortsChanged = onDetectedPortsChanged
  }

  setOnRelayLost(cb: (targetId: string) => void): void {
    this._onRelayLost = cb
  }

  setOnTerminalRelayError(cb: (targetId: string, err: RelayVersionMismatchError) => void): void {
    this._onTerminalRelayError = cb
  }

  setOnReady(cb: (targetId: string) => void): void {
    this._onReady = cb
  }

  getState(): RelaySessionState {
    return this._state
  }

  // Why: TypeScript narrows _state after control-flow checks and then
  // rejects comparisons like `this._state === 'disposed'` inside async
  // methods where it "knows" the state was e.g. 'deploying'. But dispose()
  // can mutate _state from another call stack between await points. This
  // helper defeats narrowing so the disposed checks compile correctly.
  private isDisposed(): boolean {
    return (this._state as RelaySessionState) === 'disposed'
  }

  private requireReadyConnection(): SshConnection {
    if (!this.currentConnection) {
      throw new Error('SSH connection is not active')
    }
    return this.currentConnection
  }

  getMux(): SshChannelMultiplexer | null {
    return this.mux
  }

  getHostPlatform(): RemoteHostPlatform | null {
    return this.remoteCliBridgeEnv?.hostPlatform ?? this.hostPlatform
  }

  getPortScanner(): PortScanner | null {
    return this.portScanner
  }

  prepareForHostSleep(): void {
    const mux = this.mux
    if (!mux || mux.isDisposed() || this.isDisposed()) {
      return
    }
    mux.notify(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, { graceTimeSeconds: 0 })
  }

  // Why: single entry point for relay setup — used by both initial connect
  // and app-restart reconnect. Having one path eliminates the risk of
  // forgetting a registration step.
  async establish(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot establish relay session in state: ${this._state}`)
    }
    this._state = 'deploying'
    this.currentConnection = conn

    try {
      const { transport, remoteHome, remoteRelayDir, nodePath, sockPath, hostPlatform } =
        await deployAndLaunchRelay(conn, undefined, graceTimeSeconds, this.targetId)
      this.hostPlatform = hostPlatform ?? null
      this.remoteCliBridgeEnv =
        remoteHome && remoteRelayDir && nodePath && sockPath && hostPlatform
          ? {
              binDir: joinRemotePath(hostPlatform, remoteHome, '.orca-relay', 'bin'),
              relayDir: remoteRelayDir,
              nodePath,
              sockPath,
              hostPlatform,
              pathDelimiter: hostPlatform.pathDelimiter
            }
          : null

      // Why: dispose() can fire during the await above (e.g. user clicks
      // disconnect while relay is deploying). If so, the session is already
      // cleaned up — creating a mux and registering providers would leak
      // resources with no owner to dispose them.
      if (this.isDisposed()) {
        const orphanMux = new SshChannelMultiplexer(transport)
        orphanMux.dispose()
        throw new Error('Session disposed during establish')
      }

      const mux = new SshChannelMultiplexer(transport)
      this.mux = mux
      const ownsAttempt = (): boolean => this.mux === mux && !this.isDisposed()

      // Why: verify the relay is actually responsive before registering
      // providers. In --connect mode the bridge may have already closed
      // (e.g. the grace-period relay exited because it had no PTYs), and
      // registerRelayRoots would silently swallow all mux errors, leaving
      // the session in 'ready' state with a dead mux. A round-trip request
      // here fails fast so doConnect() can report the real error.
      await mux.request('session.resolveHome', { path: '~' })

      const registered = await this.registerProviders(mux, ownsAttempt)
      if (!registered) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        throw new Error('Session disposed during establish')
      }

      // Why: the mux's transport can close during registerProviders (e.g.
      // the --connect bridge exits). registerRelayRoots swallows mux errors
      // (notifications no-op when disposed, git.listWorktrees requests are
      // try/caught), so establish would otherwise reach 'ready' with a dead
      // mux. Checking isDisposed catches this silent failure.
      if (mux.isDisposed()) {
        throw new Error('Relay connection lost during provider registration')
      }

      if (this.isDisposed()) {
        this.teardownProviders('connection_lost')
        throw new Error('Session disposed during establish')
      }

      // Why: explicit disconnect keeps PTY ownership so a later manual connect
      // must reattach those remote PTYs through the fresh relay connection.
      await this.reattachKnownPtys(ownsAttempt)

      if (!ownsAttempt()) {
        throw new Error('Session disposed during establish')
      }

      this.configureRelayGraceTime(mux, graceTimeSeconds)
      this.watchMuxForRelayLoss(mux)
      this._state = 'ready'
      this.startPortScanning()
      this._onReady?.(this.targetId)
    } catch (err) {
      // Why: if deployAndLaunchRelay succeeded but registerProviders threw
      // partway through, the mux is live and some providers may be partially
      // registered. teardownProviders cleans up everything so a subsequent
      // establish() call starts from a clean slate.
      if (!this.isDisposed()) {
        this.teardownProviders('connection_lost')
        this._state = 'idle'
      }
      // Why: a wire-handshake mismatch on the FIRST connect is also terminal
      // — the deployed relay binary on disk does not match a still-running
      // daemon (typically because a legacy daemon from before the
      // versioned-dir change is still alive). Notify the terminal-error
      // callback so ssh.ts surfaces an actionable message and the caller's
      // catch path doesn't conflate this with a transient deploy failure.
      // We still rethrow so doConnect's existing failure path runs (clean up
      // the SSH connection); ssh.ts's handler is idempotent.
      if (isRelayVersionMismatchError(err)) {
        console.warn(
          `[ssh-relay-session] Terminal relay version mismatch on initial connect for ${this.targetId}: ${err.message}`
        )
        this._onTerminalRelayError?.(this.targetId, err)
      }
      throw err
    }
  }

  // Why: network-blip reconnect path. Tears down the old provider stack,
  // deploys a fresh relay, and re-attaches any PTYs that survived the
  // relay's grace window. Guarded by an AbortController so overlapping
  // reconnect attempts (fast connection flaps) cancel the stale one.
  async reconnect(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    // Why: only allow reconnect from 'ready' or 'reconnecting'. Calling
    // reconnect from 'deploying' would tear down a mux that establish() is
    // concurrently using. 'idle' means no session was established yet.
    if (this._state !== 'ready' && this._state !== 'reconnecting') {
      return
    }

    // Cancel any in-flight reconnect
    this.abortController?.abort()
    const abortController = new AbortController()
    this.abortController = abortController

    this._state = 'reconnecting'
    this.currentConnection = conn

    // Why: stop scanning before teardownProviders so the polling timer doesn't
    // fire against a disposed multiplexer.
    this.stopPortScanning()
    await this.portForwardManager.removeAllForwards(this.targetId)
    this.broadcastEmptyLists()
    this.teardownProviders('connection_lost')

    try {
      const { transport, remoteHome, remoteRelayDir, nodePath, sockPath, hostPlatform } =
        await deployAndLaunchRelay(conn, undefined, graceTimeSeconds, this.targetId)
      this.hostPlatform = hostPlatform ?? null
      this.remoteCliBridgeEnv =
        remoteHome && remoteRelayDir && nodePath && sockPath && hostPlatform
          ? {
              binDir: joinRemotePath(hostPlatform, remoteHome, '.orca-relay', 'bin'),
              relayDir: remoteRelayDir,
              nodePath,
              sockPath,
              hostPlatform,
              pathDelimiter: hostPlatform.pathDelimiter
            }
          : null

      if (abortController.signal.aborted || this.isDisposed()) {
        // Why: the relay is already running on the remote. Creating a temporary
        // multiplexer and immediately disposing it sends a clean shutdown to the
        // relay process so it doesn't linger until its grace timer expires.
        const orphanMux = new SshChannelMultiplexer(transport)
        orphanMux.dispose()
        return
      }

      const mux = new SshChannelMultiplexer(transport)
      this.mux = mux

      const ownsAttempt = (): boolean =>
        this.abortController === abortController &&
        !abortController.signal.aborted &&
        !this.isDisposed()

      // Why: same health check as establish() — verify the relay is
      // responsive before registering providers so a dead --connect bridge
      // fails fast instead of silently producing a dead mux.
      await mux.request('session.resolveHome', { path: '~' })
      if (!ownsAttempt()) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      const registered = await this.registerProviders(mux, ownsAttempt)
      if (!registered) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      if (mux.isDisposed()) {
        throw new Error('Relay connection lost during provider registration')
      }

      // Why: dispose() can fire during registerProviders or the attach loop
      // below. If it did, providers and mux were already cleaned up by
      // dispose() — but this.mux was reassigned above, so the new mux
      // would leak. Clean it up and bail.
      if (!ownsAttempt()) {
        if (this.mux === mux) {
          this.teardownProviders('shutdown')
        } else if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      await this.reattachKnownPtys(ownsAttempt)

      if (!ownsAttempt()) {
        return
      }

      this.configureRelayGraceTime(mux, graceTimeSeconds)
      this.watchMuxForRelayLoss(mux)
      this._state = 'ready'
      this.startPortScanning()
      this._onReady?.(this.targetId)
    } catch (err) {
      // Why: clean up the mux if it was created but registration failed
      // partway through. Without this, the mux's keepalive/timeout timers
      // continue running on a half-initialized session.
      if (this.abortController === abortController && !this.isDisposed()) {
        this.teardownProviders('connection_lost')
      }
      // Why: a version-mismatch is terminal. Fire the typed callback so
      // ssh.ts can surface a "please reconnect manually" notice and skip the
      // relay-lost backoff loop entirely. We do NOT keep state at
      // 'reconnecting' — there's no transient drop to recover from.
      if (isRelayVersionMismatchError(err)) {
        console.warn(
          `[ssh-relay-session] Terminal relay version mismatch for ${this.targetId}: ${err.message}`
        )
        if (this.abortController === abortController && !this.isDisposed()) {
          this._state = 'idle'
        }
        this._onTerminalRelayError?.(this.targetId, err)
        return
      }
      // Why: stay in 'reconnecting' rather than reverting to 'ready', because
      // the provider stack is already torn down. The SSH connection manager
      // will fire another onStateChange when it reconnects again.
      console.warn(
        `[ssh-relay-session] Failed to re-establish relay for ${this.targetId}: ${err instanceof Error ? err.message : String(err)}`
      )
      if (this.abortController === abortController && !this.isDisposed()) {
        // Why: non-not-found PTY attach failures are usually transient mux or
        // relay transport failures. Treat them like relay loss so ssh.ts's
        // bounded backoff retries instead of stranding the session forever in
        // reconnecting.
        this._onRelayLost?.(this.targetId)
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null
      }
    }
  }

  dispose(): void {
    if (this._state === 'disposed') {
      return
    }
    this.abortController?.abort()
    this.stopPortScanning()
    // Why: fire-and-forget — nothing rebinds after dispose, so we don't
    // need to wait for the OS to release ports.
    void this.portForwardManager.removeAllForwards(this.targetId)
    this.broadcastEmptyLists()
    this.teardownProviders('shutdown')
    this.store.markSshRemotePtyLeases(this.targetId, 'terminated')
    this.currentConnection = null
    this._state = 'disposed'
  }

  detach(): void {
    if (this._state === 'disposed') {
      return
    }
    this.abortController?.abort()
    this.stopPortScanning()
    this.broadcastEmptyLists()
    // Why: app/window disconnect is non-destructive for remote PTYs. The relay
    // owns the grace timer, so Orca must unregister local providers without
    // clearing PTY ownership needed for reattach.
    this.teardownProviders('connection_lost')
    this.store.markSshRemotePtyLeases(this.targetId, 'detached')
    this.currentConnection = null
    this._state = 'disposed'
  }

  // ── Private ───────────────────────────────────────────────────────

  // Why: when the relay exec channel closes (e.g. --connect bridge exits,
  // relay process crashes) but the SSH connection stays up, there is no
  // automatic recovery — onStateChange only fires on SSH-level reconnects.
  // This watcher detects relay-level channel loss and fires onRelayLost
  // so ssh.ts can trigger session.reconnect() with the still-live SSH conn.
  private watchMuxForRelayLoss(mux: SshChannelMultiplexer): void {
    this.muxDisposeCleanup?.()
    this.muxDisposeCleanup = mux.onDispose((reason) => {
      if (reason === 'connection_lost' && this.mux === mux && !this.isDisposed()) {
        console.warn(
          `[ssh-relay-session] Relay channel lost for ${this.targetId}, triggering reconnect`
        )
        this._onRelayLost?.(this.targetId)
      }
    })
  }

  // Why: shared by establish() and reconnect() — the exact same provider
  // registration sequence, eliminating the duplication that caused bugs.
  private async registerProviders(
    mux: SshChannelMultiplexer,
    shouldContinue?: () => boolean
  ): Promise<boolean> {
    await this.registerRelayRoots(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    await this.installManagedHooksOnRemote(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    await this.installPluginsOnRelay(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    await this.installRemoteOrcaCliShim()
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    this.wireUpRemoteOrcaCli(mux)

    const ptyProvider = new SshPtyProvider(this.targetId, mux, this.remoteCliBridgeEnv ?? undefined)
    registerSshPtyProvider(this.targetId, ptyProvider)

    const fsProvider = new SshFilesystemProvider(this.targetId, mux, () =>
      this.requireReadyConnection().sftp()
    )
    registerSshFilesystemProvider(this.targetId, fsProvider)

    const gitProvider = new SshGitProvider(
      this.targetId,
      mux,
      this.remoteCliBridgeEnv?.hostPlatform ?? null
    )
    registerSshGitProvider(this.targetId, gitProvider)

    this.wireUpPtyEvents(ptyProvider)
    this.wireUpAgentHookEvents(mux)
    this.wireUpRemoteWorkspaceEvents(mux)
    return true
  }

  private configureRelayGraceTime(
    mux: SshChannelMultiplexer,
    graceTimeSeconds: number | undefined
  ): void {
    mux.notify(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: normalizeRelayGracePeriodSeconds(graceTimeSeconds)
    })
  }

  // Why: the relay can inject ORCA_AGENT_HOOK_* env into SSH PTYs, but
  // hook-script agents (Claude/Codex/Gemini/etc.) still need their config
  // files on the remote host to call Orca's managed script. Install those
  // configs before registering the PTY provider so newly spawned agent panes
  // report status from their first prompt.
  private async installManagedHooksOnRemote(mux: SshChannelMultiplexer): Promise<void> {
    if (!isRemoteAgentHooksEnabled() || !this.areAgentStatusHooksEnabled()) {
      return
    }
    if (
      this.remoteCliBridgeEnv?.hostPlatform &&
      isWindowsRemoteHost(this.remoteCliBridgeEnv.hostPlatform)
    ) {
      // Why: managed hook installers currently emit POSIX hook scripts and paths.
      // Windows remotes still get relay-injected env plus plugin overlays.
      return
    }

    let remoteHome: string
    try {
      const result = (await mux.request('session.resolveHome', { path: '~' })) as {
        resolvedPath?: unknown
      }
      if (typeof result.resolvedPath !== 'string' || result.resolvedPath.length === 0) {
        console.warn(
          `[ssh-relay-session] skipped remote managed hook install for ${this.targetId}: could not resolve remote home`
        )
        return
      }
      remoteHome = result.resolvedPath
    } catch (error) {
      console.warn(
        `[ssh-relay-session] skipped remote managed hook install for ${this.targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }

    let sftp: Awaited<ReturnType<SshConnection['sftp']>> | null = null
    try {
      sftp = await this.requireReadyConnection().sftp()
      await installRemoteManagedAgentHooks(sftp, remoteHome)
    } catch (error) {
      console.warn(
        `[ssh-relay-session] remote managed hook install failed for ${this.targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    } finally {
      ;(sftp as { end?: () => void } | null)?.end?.()
    }
  }

  private async installRemoteOrcaCliShim(): Promise<void> {
    if (!this.remoteCliBridgeEnv) {
      return
    }
    const { binDir, hostPlatform } = this.remoteCliBridgeEnv
    const shim = buildRemoteCliShim(this.remoteCliBridgeEnv)
    const conn = this.requireReadyConnection()
    await execCommand(conn, makeRemoteDirectoryCommand(hostPlatform, binDir), {
      wrapCommand: !isWindowsRemoteHost(hostPlatform)
    })
    if (typeof conn.writeFile === 'function') {
      await conn.writeFile(shim.path, shim.contents, { hostPlatform })
    } else {
      const sftp = await conn.sftp()
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = sftp.createWriteStream(shim.path)
          sftp.once('error', reject)
          ws.once('close', resolve)
          ws.once('error', reject)
          ws.end(shim.contents)
        })
      } finally {
        sftp.end()
      }
    }
    if (!isWindowsRemoteHost(hostPlatform)) {
      await execCommand(conn, makeRemoteExecutableCommand(hostPlatform, shim.path))
    }
  }

  private wireUpRemoteOrcaCli(mux: SshChannelMultiplexer): void {
    mux.onRequest('orca.cli', async (params) => {
      if (!this.runtime) {
        throw new Error('Orca runtime is unavailable')
      }
      const argv = Array.isArray(params.argv)
        ? params.argv.filter((item): item is string => typeof item === 'string')
        : []
      const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : '/'
      const rawEnv = params.env
      const env =
        rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
          ? Object.fromEntries(
              Object.entries(rawEnv).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === 'string' && typeof entry[1] === 'string'
              )
            )
          : {}
      const stdin = typeof params.stdin === 'string' ? params.stdin : undefined
      return await runRemoteOrcaCli(this.runtime, {
        argv,
        cwd,
        env,
        ...(stdin !== undefined ? { stdin } : {})
      })
    })
  }

  // Why: ship the OpenCode plugin / Pi extension source bodies to the relay
  // so it can materialize overlay dirs and inject OPENCODE_CONFIG_DIR
  // / PI_CODING_AGENT_DIR into spawn env. The strings change as we add agent
  // events (recent additions: cursor, pi); pinning them to the relay binary
  // would force a relay redeploy on every Orca update. See
  // docs/design/agent-status-over-ssh.md §4 + §8 (commit #7).
  //
  // Best-effort: a -32601 from an older relay (no handler installed) is
  // swallowed; the user just doesn't get OpenCode/Pi status reporting until
  // they upgrade. Hook-script-based agents use a separate explicit remote
  // installer flow because that mutates user-owned agent config files.
  private async installPluginsOnRelay(mux: SshChannelMultiplexer): Promise<void> {
    if (!isRemoteAgentHooksEnabled() || !this.areAgentStatusHooksEnabled()) {
      return
    }
    try {
      await mux.request(AGENT_HOOK_INSTALL_PLUGINS_METHOD, {
        opencodePluginSource: openCodeInternals.getOpenCodePluginSource(),
        piExtensionSource: getPiAgentStatusExtensionSource('pi'),
        ompExtensionSource: getPiAgentStatusExtensionSource('omp')
      })
    } catch (err) {
      // Why: -32601 = older relay without the handler (treat as soft skip).
      // CONNECTION_LOST / DISPOSED come from the multiplexer when it tears
      // down mid-flight (routine on session shutdown / reconnect race) — not
      // a real failure to surface; suppress to avoid log spam on every clean
      // disconnect.
      const code = (err as { code?: unknown })?.code
      if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED') {
        return
      }
      if (mux.isDisposed()) {
        return
      }
      console.warn(
        `[ssh-relay-session] agent_hook.installPlugins failed for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private areAgentStatusHooksEnabled(): boolean {
    const store = this.store as { getSettings?: Store['getSettings'] }
    return isAgentStatusHooksEnabled(store.getSettings?.())
  }

  private wireUpRemoteWorkspaceEvents(mux: SshChannelMultiplexer): void {
    mux.onNotification((method, params) => {
      notifyRemoteWorkspaceHandlers(this.targetId, method, params)
    })
  }

  // Why: route the relay's `agent.hook` JSON-RPC notification into Orca's
  // shared `agentHookServer` via `ingestRemote`. The wire envelope carries
  // `connectionId: null` (the relay does not know Orca's local handle); we
  // stamp the real value here from `this.targetId` so the renderer can drop
  // in-flight events for connections that have torn down. After wiring is
  // in place we kick off a request-driven replay so any cached payload from
  // before the channel was up survives the reconnect — see §5 Path 3.
  //
  // The Orca-side mux's `notificationHandlers` is a flat array — each
  // handler must filter by method name itself.
  private wireUpAgentHookEvents(mux: SshChannelMultiplexer): void {
    if (!isRemoteAgentHooksEnabled()) {
      return
    }
    // Why: capture the disposer so teardownProviders can release the
    // notification handler symmetrically with muxDisposeCleanup. Even though
    // the disposed mux's handler array is GC'd along with it today, retaining
    // the disposer makes "registerProviders called twice on the same mux"
    // safe by future-proofing against duplicate handler registration.
    this.muxNotificationCleanup?.()
    this.muxNotificationCleanup = mux.onNotification((method, params) => {
      if (method !== AGENT_HOOK_NOTIFICATION_METHOD) {
        return
      }
      const envelope = params as {
        paneKey?: unknown
        tabId?: unknown
        worktreeId?: unknown
        env?: unknown
        version?: unknown
        hasExplicitPrompt?: unknown
        promptInteractionKey?: unknown
        hookEventName?: unknown
        toolUseId?: unknown
        toolAgentId?: unknown
        toolAgentType?: unknown
        isReplay?: unknown
        providerSession?: unknown
        payload?: unknown
      }
      if (typeof envelope.paneKey !== 'string') {
        return
      }
      // Why: forward env/version verbatim so Orca's warn-once cross-build /
      // dev-vs-prod diagnostics fire on remote events the same as on local
      // ones — see docs/design/agent-status-over-ssh.md §3 ("Replay /
      // version mismatch") and the relay's wire envelope at
      // src/shared/agent-hook-relay.ts.
      agentHookServer.ingestRemote(
        {
          paneKey: envelope.paneKey,
          tabId: typeof envelope.tabId === 'string' ? envelope.tabId : undefined,
          worktreeId: typeof envelope.worktreeId === 'string' ? envelope.worktreeId : undefined,
          env: typeof envelope.env === 'string' ? envelope.env : undefined,
          version: typeof envelope.version === 'string' ? envelope.version : undefined,
          hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
          promptInteractionKey:
            typeof envelope.promptInteractionKey === 'string'
              ? envelope.promptInteractionKey
              : undefined,
          hookEventName:
            typeof envelope.hookEventName === 'string' ? envelope.hookEventName : undefined,
          toolUseId: typeof envelope.toolUseId === 'string' ? envelope.toolUseId : undefined,
          toolAgentId: typeof envelope.toolAgentId === 'string' ? envelope.toolAgentId : undefined,
          toolAgentType:
            typeof envelope.toolAgentType === 'string' ? envelope.toolAgentType : undefined,
          isReplay: envelope.isReplay === true ? true : undefined,
          providerSession: envelope.providerSession,
          payload: envelope.payload
        },
        this.targetId
      )
    })

    // Why: ask the relay to replay every cached paneKey it remembers. Issued
    // *after* the handler is wired so the request-driven replay shape
    // strictly trails our subscription on the dispatcher's single write
    // callback. Best-effort: a relay that does not know the method
    // (e.g. older relay binary) returns -32601; CONNECTION_LOST / DISPOSED
    // arise from mux teardown mid-flight on routine reconnect/shutdown.
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch((err) => {
      const code = (err as { code?: unknown })?.code
      if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED') {
        return
      }
      if (mux.isDisposed()) {
        return
      }
      // Why: a normal disconnect/teardown rejects the in-flight request with
      // "Multiplexer disposed"; suppress the warn for that path so reconnect
      // cycles aren't noisy.
      if (mux.isDisposed()) {
        return
      }
      console.warn(
        `[ssh-relay-session] agent_hook.requestReplay failed for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })
  }

  private teardownProviders(reason: 'shutdown' | 'connection_lost'): void {
    this.muxDisposeCleanup?.()
    this.muxDisposeCleanup = null
    this.muxNotificationCleanup?.()
    this.muxNotificationCleanup = null
    if (this.mux && !this.mux.isDisposed()) {
      this.mux.dispose(reason)
    }
    this.mux = null

    if (reason === 'shutdown') {
      clearPtyOwnershipForConnection(this.targetId)
    }

    const ptyProvider = getSshPtyProvider(this.targetId)
    if (ptyProvider && 'dispose' in ptyProvider) {
      ;(ptyProvider as { dispose: () => void }).dispose()
    }
    const fsProvider = getSshFilesystemProvider(this.targetId)
    if (fsProvider && 'dispose' in fsProvider) {
      ;(fsProvider as { dispose: () => void }).dispose()
    }

    unregisterSshPtyProvider(this.targetId)
    unregisterSshFilesystemProvider(this.targetId)
    unregisterSshGitProvider(this.targetId)
  }

  // Why: kept for back-compat with old relay binaries during the upgrade
  // window — those still gate FS ops on registered roots. New relays no-op
  // these notifications. Tracked for removal once the relay-version floor
  // moves past the cutover (see docs/relay-fs-allowlist-removal.md).
  private async registerRelayRoots(mux: SshChannelMultiplexer): Promise<void> {
    const remoteRepos = this.store.getRepos().filter((r) => r.connectionId === this.targetId)

    for (const repo of remoteRepos) {
      mux.notify('session.registerRoot', { rootPath: repo.path })
    }

    // Why: git.listWorktrees requires the repo root to be registered first.
    await Promise.all(
      remoteRepos.map(async (repo) => {
        try {
          const worktrees = (await mux.request('git.listWorktrees', {
            repoPath: repo.path
          })) as { path: string }[]
          for (const wt of worktrees) {
            if (wt.path !== repo.path) {
              mux.notify('session.registerRoot', { rootPath: wt.path })
            }
          }
        } catch {
          // git worktree list may fail for folder-mode repos — not fatal
        }
      })
    )
  }

  // Why: extracted so establish() and reconnect() share exactly the same
  // event wiring. Previously forgetting to wire onReplay on one path
  // caused silent terminal blanking after reconnect.
  private broadcastEmptyLists(): void {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    win.webContents.send('ssh:port-forwards-changed', {
      targetId: this.targetId,
      forwards: []
    })
    win.webContents.send('ssh:detected-ports-changed', {
      targetId: this.targetId,
      ports: []
    })
  }

  private startPortScanning(): void {
    if (!this.mux || this.isDisposed()) {
      return
    }
    const scanner = new PortScanner()
    this.portScanner = scanner
    // Why: capture the scanner instance so that a late ports.detect callback
    // from a previous relay session (before reconnect replaced it) is silently
    // discarded instead of publishing stale results into the new session.
    scanner.startScanning(this.targetId, this.mux, (targetId, ports, platform) => {
      if (this.portScanner !== scanner) {
        return
      }
      this.onDetectedPortsChanged?.(targetId, ports, platform)
    })
  }

  private stopPortScanning(): void {
    if (this.portScanner) {
      this.portScanner.stopScanning(this.targetId)
      this.portScanner = null
    }
  }

  private wireUpPtyEvents(ptyProvider: SshPtyProvider): void {
    ptyProvider.onData((payload) => {
      const seq = this.runtime?.onPtyData(payload.id, payload.data, Date.now())
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:data', {
          ...payload,
          ...(typeof seq === 'number' ? { seq, rawLength: payload.data.length } : {})
        })
      }
    })
    ptyProvider.onReplay((payload) => {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:replay', payload)
      }
    })
    ptyProvider.onExit((payload) => {
      const relayPtyId = toRelaySshPtyId(this.targetId, payload.id)
      clearProviderPtyState(payload.id)
      deletePtyOwnership(payload.id)
      this.store.markSshRemotePtyLease(this.targetId, relayPtyId, 'terminated')
      this.runtime?.onPtyExit(payload.id, payload.code)
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', payload)
      }
    })
  }

  private async reattachKnownPtys(shouldContinue: () => boolean): Promise<void> {
    const leasedPtyIds = this.store
      .getSshRemotePtyLeases(this.targetId)
      .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
      .map((lease) => lease.ptyId)
    // Why: after app restart, ptyOwnership is empty but durable SSH leases
    // still describe remote PTYs that survived in the relay grace window.
    const ptyIds = Array.from(
      new Set([
        ...getPtyIdsForConnection(this.targetId).map((ptyId) =>
          toRelaySshPtyId(this.targetId, ptyId)
        ),
        ...leasedPtyIds
      ])
    )
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    if (!ptyProvider) {
      return
    }
    for (const ptyId of ptyIds) {
      if (!shouldContinue()) {
        return
      }
      try {
        await ptyProvider.attach(ptyId)
        if (!shouldContinue()) {
          return
        }
        const appPtyId = toAppSshPtyId(this.targetId, ptyId)
        setPtyOwnership(appPtyId, this.targetId)
        this.store.markSshRemotePtyLease(this.targetId, ptyId, 'attached')
      } catch (err) {
        if (!isSshPtyNotFoundError(err)) {
          throw err
        }
        console.warn(
          `[ssh-relay-session] Dropping stale PTY ${ptyId} for ${this.targetId} after relay reattach failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        const appPtyId = toAppSshPtyId(this.targetId, ptyId)
        clearProviderPtyState(appPtyId)
        deletePtyOwnership(appPtyId)
        this.store.markSshRemotePtyLease(this.targetId, ptyId, 'expired')
        // Why: if the new relay cannot reattach this id, the remote backing
        // process is gone. Tell the renderer so it clears stale pane bindings
        // instead of keeping a cursor-only terminal.
        const win = this.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('pty:exit', { id: appPtyId, code: -1 })
        }
      }
    }
  }
}

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function buildRemoteCliShim(env: RemoteCliBridgeEnv): {
  path: string
  contents: string
} {
  if (isWindowsRemoteHost(env.hostPlatform)) {
    const shimPath = joinRemotePath(env.hostPlatform, env.binDir, 'orca.cmd')
    return {
      path: shimPath,
      contents: [
        '@echo off',
        'setlocal',
        `if not defined ORCA_RELAY_NODE_PATH set "ORCA_RELAY_NODE_PATH=${env.nodePath}"`,
        `if not defined ORCA_RELAY_DIR set "ORCA_RELAY_DIR=${env.relayDir}"`,
        `if not defined ORCA_RELAY_SOCKET_PATH set "ORCA_RELAY_SOCKET_PATH=${env.sockPath}"`,
        '"%ORCA_RELAY_NODE_PATH%" "%ORCA_RELAY_DIR%/relay.js" --sock-path "%ORCA_RELAY_SOCKET_PATH%" --orca-cli %*',
        'exit /b %ERRORLEVEL%',
        ''
      ].join('\r\n')
    }
  }

  const shimPath = joinRemotePath(env.hostPlatform, env.binDir, 'orca')
  return {
    path: shimPath,
    contents: [
      '#!/usr/bin/env sh',
      'set -eu',
      `ORCA_RELAY_NODE_PATH=\${ORCA_RELAY_NODE_PATH:-${quoteSh(env.nodePath)}}`,
      `ORCA_RELAY_DIR=\${ORCA_RELAY_DIR:-${quoteSh(env.relayDir)}}`,
      `ORCA_RELAY_SOCKET_PATH=\${ORCA_RELAY_SOCKET_PATH:-${quoteSh(env.sockPath)}}`,
      'if [ ! -S "$ORCA_RELAY_SOCKET_PATH" ]; then',
      '  echo "Orca SSH CLI bridge cannot find the relay socket: $ORCA_RELAY_SOCKET_PATH" >&2',
      '  exit 1',
      'fi',
      'exec "$ORCA_RELAY_NODE_PATH" "$ORCA_RELAY_DIR/relay.js" --sock-path "$ORCA_RELAY_SOCKET_PATH" --orca-cli "$@"',
      ''
    ].join('\n')
  }
}
