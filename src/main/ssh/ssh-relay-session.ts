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
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshGitProvider } from '../providers/ssh-git-provider'
import {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  deletePtyOwnership
} from '../ipc/pty'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { PortScanner } from './ssh-port-scanner'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import type { DetectedPort } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type RelaySessionState = 'idle' | 'deploying' | 'ready' | 'reconnecting' | 'disposed'

export class SshRelaySession {
  private _state: RelaySessionState = 'idle'
  private mux: SshChannelMultiplexer | null = null
  private abortController: AbortController | null = null
  private muxDisposeCleanup: (() => void) | null = null
  // Why: when the relay exec channel closes but the SSH connection stays
  // up, the onStateChange reconnect path never fires. This callback lets
  // ssh.ts wire up relay-level reconnect from outside the session.
  private _onRelayLost: ((targetId: string) => void) | null = null
  private _onReady: ((targetId: string) => void) | null = null
  private portScanner: PortScanner | null = null

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

  setOnRelayLost(cb: (targetId: string) => void): void {
    this._onRelayLost = cb
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

  getMux(): SshChannelMultiplexer | null {
    return this.mux
  }

  getPortScanner(): PortScanner | null {
    return this.portScanner
  }

  // Why: single entry point for relay setup — used by both initial connect
  // and app-restart reconnect. Having one path eliminates the risk of
  // forgetting a registration step.
  async establish(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot establish relay session in state: ${this._state}`)
    }
    this._state = 'deploying'

    try {
      const { transport } = await deployAndLaunchRelay(
        conn,
        undefined,
        graceTimeSeconds,
        this.targetId
      )

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

      // Why: verify the relay is actually responsive before registering
      // providers. In --connect mode the bridge may have already closed
      // (e.g. the grace-period relay exited because it had no PTYs), and
      // registerRelayRoots would silently swallow all mux errors, leaving
      // the session in 'ready' state with a dead mux. A round-trip request
      // here fails fast so doConnect() can report the real error.
      await mux.request('session.resolveHome', { path: '~' })

      await this.registerProviders(mux)

      // Why: the mux's transport can close during registerProviders (e.g.
      // the --connect bridge exits). registerRelayRoots swallows mux errors
      // (notifications no-op when disposed, git.listWorktrees requests are
      // try/caught), so establish would otherwise reach 'ready' with a dead
      // mux. Checking isDisposed catches this silent failure.
      if (mux.isDisposed()) {
        throw new Error('Relay connection lost during provider registration')
      }

      if (this.isDisposed()) {
        this.teardownProviders('shutdown')
        throw new Error('Session disposed during establish')
      }

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
        this.teardownProviders('shutdown')
        this._state = 'idle'
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

    // Why: stop scanning before teardownProviders so the polling timer doesn't
    // fire against a disposed multiplexer.
    this.stopPortScanning()
    await this.portForwardManager.removeAllForwards(this.targetId)
    this.broadcastEmptyLists()
    this.teardownProviders('connection_lost')

    try {
      const { transport } = await deployAndLaunchRelay(
        conn,
        undefined,
        graceTimeSeconds,
        this.targetId
      )

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

      // Re-attach to any PTYs that were alive before the disconnect.
      const ptyIds = getPtyIdsForConnection(this.targetId)
      const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
      if (ptyProvider) {
        for (const ptyId of ptyIds) {
          if (!ownsAttempt()) {
            return
          }
          try {
            await ptyProvider.attach(ptyId)
          } catch (err) {
            console.warn(
              `[ssh-relay-session] Dropping stale PTY ${ptyId} for ${this.targetId} after relay reattach failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            clearProviderPtyState(ptyId)
            deletePtyOwnership(ptyId)
            // Why: if the new relay cannot reattach this id, the remote
            // backing process is gone. Tell the renderer so it clears stale
            // pane bindings instead of keeping a cursor-only terminal.
            const win = this.getMainWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send('pty:exit', { id: ptyId, code: -1 })
            }
          }
        }
      }

      if (!ownsAttempt()) {
        return
      }

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
      // Why: stay in 'reconnecting' rather than reverting to 'ready', because
      // the provider stack is already torn down. The SSH connection manager
      // will fire another onStateChange when it reconnects again.
      console.warn(
        `[ssh-relay-session] Failed to re-establish relay for ${this.targetId}: ${err instanceof Error ? err.message : String(err)}`
      )
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

    const ptyProvider = new SshPtyProvider(this.targetId, mux)
    registerSshPtyProvider(this.targetId, ptyProvider)

    const fsProvider = new SshFilesystemProvider(this.targetId, mux)
    registerSshFilesystemProvider(this.targetId, fsProvider)

    const gitProvider = new SshGitProvider(this.targetId, mux)
    registerSshGitProvider(this.targetId, gitProvider)

    this.wireUpPtyEvents(ptyProvider)
    return true
  }

  private teardownProviders(reason: 'shutdown' | 'connection_lost'): void {
    this.muxDisposeCleanup?.()
    this.muxDisposeCleanup = null
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
    const getWin = this.getMainWindow
    ptyProvider.onData((payload) => {
      this.runtime?.onPtyData(payload.id, payload.data, Date.now())
      const win = getWin()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:data', payload)
      }
    })
    ptyProvider.onReplay((payload) => {
      const win = getWin()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:replay', payload)
      }
    })
    ptyProvider.onExit((payload) => {
      clearProviderPtyState(payload.id)
      deletePtyOwnership(payload.id)
      this.runtime?.onPtyExit(payload.id, payload.code)
      const win = getWin()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', payload)
      }
    })
  }
}
