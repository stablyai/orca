/**
 * Which earlier-build relay, if any, serves a PTY the current relay answered "not found" for.
 *
 * Opens a route to each older endpoint the deploy's census found only when a pane asks for a PTY the
 * current relay disowned, keeps the route while it serves a pane, and hangs it up once it serves
 * none. An unreachable or non-bridgeable relay leaves the pane held, never respawned.
 */
import type { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshPtyExitCallback } from '../providers/ssh-pty-provider-contract'
import type { SshPtyLegacyRelayRouting } from '../providers/ssh-pty-legacy-relay-delegation'
import type { SshLegacyRelayRoute } from './ssh-legacy-relay-route'

export type SshLegacyRelayRouterOptions = {
  targetId: string
  endpoints: () => Promise<string[]>
  /** True when an older relay may run PTYs no route can reach: an incomplete or Windows census. */
  unreachableMayHold?: () => Promise<boolean>
  openRoute: (sockPath: string) => Promise<SshLegacyRelayRoute | null>
}

type RouteEntry = {
  pending: Promise<SshLegacyRelayRoute | null>
  /** Set once opened; synchronous lookups read only routes that finished opening. */
  route?: SshLegacyRelayRoute | null
  /** Callers awaiting or reading the route; it closes only once none remain and it serves nothing. */
  users: number
}

export class SshLegacyRelayRouter implements SshPtyLegacyRelayRouting {
  private readonly routes = new Map<string, RouteEntry>()
  private readonly disposeListeners = new Set<() => void>()
  private readonly exitListeners = new Set<SshPtyExitCallback>()
  private disposed = false

  constructor(private readonly options: SshLegacyRelayRouterOptions) {}

  /** The route's provider for a pane being attached, already marked as served. */
  async attach(
    appPtyId: string
  ): Promise<{ provider: SshPtyProvider; release: () => void } | null> {
    for (const sockPath of await this.options.endpoints()) {
      const served = await this.use(
        sockPath,
        'legacy-relay-holds-no-requested-terminal',
        (route) => {
          if (!route?.holds(appPtyId) || this.disposed) {
            return null
          }
          route.beginServing(appPtyId)
          return {
            provider: route.provider,
            release: () => this.release(sockPath, route, appPtyId)
          }
        }
      )
      if (served || this.disposed) {
        return served
      }
    }
    return null
  }

  /**
   * Every PTY the older relays still run, for the migration terminal gate. Null when one of them
   * could not be asked: an unreachable or non-bridgeable relay is unverifiable, never empty.
   */
  async listHeld(): Promise<string[] | null> {
    const held: string[] = []
    for (const sockPath of await this.options.endpoints()) {
      const listed = await this.use(sockPath, 'legacy-relay-listed-for-terminal-gate', (route) =>
        route && !this.disposed ? route.heldPtyIds() : null
      )
      if (!listed) {
        return null
      }
      held.push(...listed)
    }
    return held
  }

  /** Releases a pane whose attach through the route did not complete. */
  private release(sockPath: string, route: SshLegacyRelayRoute, appPtyId: string): void {
    route.stopServing(appPtyId)
    this.closeIfIdle(this.routes.get(sockPath), 'legacy-relay-attach-abandoned')
  }

  /** Never closes a route another caller is still awaiting: only the last user may hang it up. */
  private async use<T>(
    sockPath: string,
    idleReason: string,
    read: (route: SshLegacyRelayRoute | null) => T
  ): Promise<T> {
    const entry = this.entry(sockPath)
    entry.users += 1
    try {
      return read(await entry.pending)
    } finally {
      entry.users -= 1
      this.closeIfIdle(entry, idleReason)
    }
  }

  private closeIfIdle(entry: RouteEntry | undefined, reason: string): void {
    if (entry?.route && entry.users === 0 && !entry.route.servesAny) {
      entry.route.close(reason)
    }
  }

  providerFor(appPtyId: string): SshPtyProvider | undefined {
    for (const { route } of this.routes.values()) {
      if (route?.serves(appPtyId)) {
        return route.provider
      }
    }
    return undefined
  }

  /**
   * Stops a PTY an older relay holds but no pane is served for: a short-lived route opens through
   * the old relay's bridge, the stop runs there, and the route hangs up once that PTY exits. False
   * when no older relay lists it; `reachable` false when one may but could not be asked.
   */
  async stopHeld(
    appPtyId: string,
    stop: (provider: SshPtyProvider) => Promise<void>
  ): Promise<{ stopped: true } | { stopped: false; reachable: boolean }> {
    let reachable = !(await this.options.unreachableMayHold?.())
    for (const sockPath of await this.options.endpoints()) {
      const route = await this.use(sockPath, 'legacy-relay-holds-no-stopped-terminal', (opened) => {
        if (!opened && !this.disposed) {
          reachable = false
        }
        if (!opened?.holds(appPtyId) || this.disposed) {
          return null
        }
        opened.beginServing(appPtyId)
        return opened
      })
      if (route) {
        try {
          await route.track(() => stop(route.provider))
        } catch (error) {
          this.release(sockPath, route, appPtyId)
          throw error
        }
        return { stopped: true }
      }
    }
    return { stopped: false, reachable }
  }

  /** Runs a request for a served PTY on its route, or undefined when no route serves it. */
  track<T>(
    appPtyId: string,
    request: (provider: SshPtyProvider) => Promise<T>
  ): Promise<T> | undefined {
    for (const { route } of this.routes.values()) {
      if (route?.serves(appPtyId)) {
        return route.track(() => request(route.provider))
      }
    }
    return undefined
  }

  /** Exits the older relays report for the PTYs their routes serve. */
  onExit(listener: SshPtyExitCallback): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Every pane a route serves, for listings that must not read a served PTY as gone. */
  servedProviders(): SshPtyProvider[] {
    const providers: SshPtyProvider[] = []
    for (const { route } of this.routes.values()) {
      if (route?.servesAny) {
        providers.push(route.provider)
      }
    }
    return providers
  }

  onDispose(listener: () => void): void {
    this.disposeListeners.add(listener)
  }

  dispose(): void {
    this.disposed = true
    this.disposeListeners.forEach((listener) => listener())
    for (const { route } of this.routes.values()) {
      route?.close('legacy-relay-router-disposed')
    }
    this.routes.clear()
  }

  private entry(sockPath: string): RouteEntry {
    const existing = this.routes.get(sockPath)
    if (existing) {
      return existing
    }
    const entry: RouteEntry = { pending: Promise.resolve(null), users: 0 }
    entry.pending = this.options.openRoute(sockPath).then(
      (route) => {
        entry.route = route
        route?.onServedExit((payload) =>
          this.exitListeners.forEach((listener) => listener(payload))
        )
        route?.onClose(() => {
          if (this.routes.get(sockPath) === entry) {
            this.routes.delete(sockPath)
          }
        })
        if (this.disposed) {
          route?.close('legacy-relay-router-disposed')
        }
        return route
      },
      (error: unknown) => {
        console.warn(
          `[ssh-relay] Previous relay at ${sockPath} could not be reached for ${this.options.targetId}; its terminals stay held: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (this.routes.get(sockPath) === entry) {
          this.routes.delete(sockPath)
        }
        return null
      }
    )
    this.routes.set(sockPath, entry)
    return entry
  }
}
