/**
 * One live relay from an earlier Orca build, reached through that build's own bridge.
 *
 * An app update leaves the previous relay running its terminals, and that relay refuses this build's
 * handshake because it compares bundle hashes exactly. Its own `relay.js --connect`, run from its
 * own version directory, presents its own hash by construction, so a client of any later build can
 * still reach it. This route opens that bridge, takes the PTY owner role without output flow control
 * (which no shipped relay requires), and lends its PTYs to the target's provider until they exit.
 */
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from '../providers/ssh-pty-provider-contract'
import { sshProvidersByGeneration } from '../ipc/pty/provider/registry'
import {
  allocateSshPtyProviderGeneration,
  closeSshPtyOutputGeneration
} from '../ipc/ssh-pty-output-intake-registry'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { shellEscape } from './ssh-connection-utils'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from './relay-socket-path-limit'
import { openSshPtyConsumerSession } from './ssh-pty-consumer-session'
import { retrySshOwnerRecoveryWhileBlocked } from './ssh-owner-recovery-retry'

export type LegacyRelayBridge = {
  /** The version directory that holds the old build's `relay.js` and `.version`. */
  relayDir: string
  connectCommand: string
  versionCommand: string
}

/**
 * Only an endpoint inside its own `relay-<version>` directory names the build that serves it. A
 * socket relocated under the short `/tmp` base does not, so that relay is left held, not guessed at.
 */
export function legacyRelayBridge(nodePath: string, sockPath: string): LegacyRelayBridge | null {
  const slash = sockPath.lastIndexOf('/')
  const relayDir = sockPath.slice(0, slash)
  const dirName = relayDir.slice(relayDir.lastIndexOf('/') + 1)
  if (
    slash <= 0 ||
    !dirName.startsWith('relay-') ||
    sockPath.startsWith(SHORT_RELAY_SOCKET_DIR_PREFIX)
  ) {
    return null
  }
  const dir = shellEscape(relayDir)
  return {
    relayDir,
    connectCommand:
      `cd ${dir} && ${shellEscape(nodePath)} relay.js --connect --sock-path ${shellEscape(sockPath)} ` +
      `--credential-file ${shellEscape(`${sockPath}.credential`)}`,
    versionCommand: `cat ${dir}/.version`
  }
}

export type LegacyRelayRouteSink = {
  data: SshPtyDataCallback
  exit: SshPtyExitCallback
  replay: SshPtyReplayCallback
}

export type LegacyRelayRouteOptions = {
  targetId: string
  sockPath: string
  nodePath: string
  clientInstanceId: string
  openTransport: (command: string) => Promise<MultiplexerTransport>
  readText: (command: string) => Promise<string>
  sink: LegacyRelayRouteSink
}

export class SshLegacyRelayRoute {
  /** App PTY ids the old relay listed when the route opened. */
  private readonly listed = new Set<string>()
  /** App PTY ids whose panes this route currently serves. */
  private readonly attached = new Set<string>()
  /** App PTY ids whose exit the old relay reported. */
  private readonly exited = new Set<string>()
  private closed = false
  private readonly closeListeners = new Set<() => void>()
  private readonly servedExitListeners = new Set<SshPtyExitCallback>()
  /** Requests still awaiting the old relay; the bridge stays up until they settle. */
  private inFlight = 0
  private closeWhenSettled: string | null = null

  private constructor(
    readonly sockPath: string,
    readonly provider: SshPtyProvider,
    private readonly mux: SshChannelMultiplexer
  ) {
    mux.onDispose(() => this.close('legacy-relay-transport-closed'))
  }

  static async open(options: LegacyRelayRouteOptions): Promise<SshLegacyRelayRoute | null> {
    const bridge = legacyRelayBridge(options.nodePath, options.sockPath)
    if (!bridge) {
      return null
    }
    const serverBuildId = (await options.readText(bridge.versionCommand)).trim()
    const mux = new SshChannelMultiplexer(await options.openTransport(bridge.connectCommand))
    try {
      // No flow control requested: the old relay then publishes plain frames acked by char count.
      await retrySshOwnerRecoveryWhileBlocked(
        () =>
          openSshPtyConsumerSession(mux, {
            clientInstanceId: options.clientInstanceId,
            expectedServerBuildId: serverBuildId
          }),
        { isCurrent: () => !mux.isDisposed(), onClosed: (listener) => mux.onDispose(listener) }
      )
      const generation = allocateSshPtyProviderGeneration()
      const provider = new SshPtyProvider(options.targetId, mux, undefined, generation)
      const route = new SshLegacyRelayRoute(options.sockPath, provider, mux)
      route.wire(options.sink)
      route.settleShutdownOnExit()
      sshProvidersByGeneration.set(generation, provider)
      for (const process of await provider.listProcesses()) {
        route.listed.add(process.id)
      }
      return route
    } catch (error) {
      mux.dispose()
      throw error
    }
  }

  /** The app PTY ids the old relay listed when the route opened, minus those that exited since. */
  heldPtyIds(): string[] {
    return this.closed ? [] : [...this.listed]
  }

  holds(appPtyId: string): boolean {
    return !this.closed && this.listed.has(appPtyId)
  }

  serves(appPtyId: string): boolean {
    return !this.closed && this.attached.has(appPtyId)
  }

  get servesAny(): boolean {
    return this.attached.size > 0
  }

  beginServing(appPtyId: string): void {
    this.attached.add(appPtyId)
    // A pane served again cancels a hang-up the last exit deferred until a stop settled.
    this.closeWhenSettled = null
  }

  stopServing(appPtyId: string): void {
    this.attached.delete(appPtyId)
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener)
  }

  /** Exits of PTYs this route served, as the old relay reported them. */
  onServedExit(listener: SshPtyExitCallback): void {
    this.servedExitListeners.add(listener)
  }

  /**
   * Runs a request on the old relay without the bridge closing under it. Why: a stop's PTY exit can
   * arrive before the stop's own reply, and closing on that exit used to fail the stop.
   */
  async track<T>(request: () => Promise<T>): Promise<T> {
    this.inFlight += 1
    try {
      return await request()
    } finally {
      this.inFlight -= 1
      if (this.inFlight === 0 && this.closeWhenSettled !== null && !this.servesAny) {
        this.close(this.closeWhenSettled)
      }
    }
  }

  /** Hangs up the bridge; the old relay keeps whatever still runs and its own grace decides the rest. */
  close(reason: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    const generation = this.provider.providerGeneration
    if (sshProvidersByGeneration.get(generation) === this.provider) {
      sshProvidersByGeneration.delete(generation)
    }
    closeSshPtyOutputGeneration(generation, reason)
    this.provider.dispose()
    this.mux.dispose()
    for (const listener of this.closeListeners) {
      listener()
    }
  }

  /**
   * The old relay reports the exit before the shutdown reply, and that exit can close the route; a
   * shutdown whose PTY was seen exiting then succeeded, whatever the hung-up transport says.
   */
  private settleShutdownOnExit(): void {
    const shutdown = this.provider.shutdown.bind(this.provider)
    this.provider.shutdown = async (id, opts) => {
      try {
        await shutdown(id, opts)
      } catch (error) {
        if (!this.exited.has(id)) {
          throw error
        }
      }
    }
  }

  private wire(sink: LegacyRelayRouteSink): void {
    // Why filtered: the owner role delivers every PTY on the old relay, and only served panes want it.
    this.provider.onData((payload) => {
      if (this.serves(payload.id)) {
        sink.data(payload)
      }
    })
    this.provider.onReplay((payload) => {
      if (this.serves(payload.id)) {
        sink.replay(payload)
      }
    })
    this.provider.onExit((payload) => {
      // Why before the serves check: an unserved PTY that exits is no longer held either.
      this.listed.delete(payload.id)
      this.exited.add(payload.id)
      if (!this.serves(payload.id)) {
        return
      }
      sink.exit(payload)
      this.servedExitListeners.forEach((listener) => listener(payload))
      this.attached.delete(payload.id)
      if (this.attached.size > 0) {
        return
      }
      if (this.inFlight > 0) {
        this.closeWhenSettled = 'legacy-relay-terminals-exited'
      } else {
        this.close('legacy-relay-terminals-exited')
      }
    })
  }
}
