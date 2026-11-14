import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { MobileRelayHostsListResult } from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

// A phone holding the list reads it at least every 60 s (its backstop); three missed reads means none is left.
export const PHONE_LIST_IDLE_MS = 3 * 60_000

export type RelayHostListAnnouncerSources = {
  onClientEvent: (listener: (event: RuntimeClientEvent) => void) => () => void
  changed: () => void
}

type Watching = { announced: string; stop: () => void; idle: ReturnType<typeof setTimeout> }

/**
 * Calls `changed` whenever the host list would answer differently from what phones last saw.
 * It watches only while phones read the list: a desktop no phone asks pays no watch or timer.
 */
export class RelayHostListAnnouncer {
  private watching: Watching | null = null
  private disposed = false

  constructor(
    private readonly hosts: MobileDesktopRelayHosts,
    private readonly describe: () => MobileRelayHostsListResult,
    private readonly sources: RelayHostListAnnouncerSources
  ) {}

  /** A phone just read `result`. */
  listed(result: MobileRelayHostsListResult): void {
    if (this.disposed) {
      return
    }
    if (this.watching) {
      clearTimeout(this.watching.idle)
      this.watching.idle = this.idleTimer()
      return
    }
    // Later reads don't move the baseline: a read racing a change would hide it from other phones.
    this.watching = {
      announced: JSON.stringify(result),
      stop: this.watch(),
      idle: this.idleTimer()
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopWatching()
  }

  private idleTimer(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.stopWatching(), PHONE_LIST_IDLE_MS)
    timer.unref?.()
    return timer
  }

  private stopWatching(): void {
    const watching = this.watching
    this.watching = null
    if (watching) {
      clearTimeout(watching.idle)
      watching.stop()
    }
  }

  private watch(): () => void {
    let queued = false
    const check = (): void => {
      if (queued) {
        return
      }
      queued = true
      // One change can reach several sources, e.g. a retirement and its new status owner.
      queueMicrotask(() => {
        queued = false
        const watching = this.watching
        if (!watching) {
          return
        }
        const next = this.describeForAnnouncement()
        if (next !== watching.announced) {
          watching.announced = next
          this.sources.changed()
        }
      })
    }
    const stops = [
      this.hosts.onStatusChanged(check),
      this.hosts.onEnvironmentRetired(check),
      this.hosts.onCatalogChanged?.(check),
      this.sources.onClientEvent((event) => {
        // SSH targets carry managed servers' labels and health; host label overrides live in settings.
        if (
          event.type === 'sshStateChanged' ||
          (event.type === 'settingsChanged' && event.keys.includes('hostSettingOverrides'))
        ) {
          check()
        }
      })
    ]
    return () => {
      for (const stop of stops) {
        stop?.()
      }
    }
  }

  // A store that can't be read must not throw here, outside any request; phones re-read and get the error.
  private describeForAnnouncement(): string {
    try {
      return JSON.stringify(this.describe())
    } catch {
      return 'unreadable'
    }
  }
}
