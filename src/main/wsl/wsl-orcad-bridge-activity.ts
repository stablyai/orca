/**
 * The bridged loopback sockets a WSL host's listener carries (the desktop's own control and
 * request connections), read as a liveness watch so no extra wsl.exe bridge is held just to see
 * orcad exit. The guest ending the last open socket means orcad closed it or exited; anything it
 * means for certain is settled by the supervisor's verify.
 */
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'
import type { WslOrcadWatch } from './wsl-orcad-watch'

export type WslOrcadBridgeChannelEvents = {
  opened(): void
  /** `byGuest` when the guest side ended before the desktop closed or ended its side. */
  ended(byGuest: boolean): void
}

/** Reports a bridge channel's lifetime; a close or stdin EOF from the desktop is not the guest's. */
export function observeWslOrcadBridgeChannel(
  channel: RemoteCommandChannel,
  events: WslOrcadBridgeChannelEvents
): RemoteCommandChannel {
  let closedLocally = false
  const close = channel.close.bind(channel)
  channel.close = () => {
    closedLocally = true
    close()
  }
  // Decided when the guest's output ends: by then the desktop may already be hanging up in turn.
  const guestFirst = (): boolean => !closedLocally && !channel.writableEnded
  let byGuest: boolean | null = null
  channel.once('end', () => {
    byGuest ??= guestFirst()
  })
  events.opened()
  channel.once('exit', () => events.ended(byGuest ?? guestFirst()))
  return channel
}

/** Exit signals this close together are one orcad exit, or one-shot sockets coming and going. */
export const WSL_ORCAD_BRIDGE_EXIT_COOLDOWN_MS = 2_000

type ActivityListener = (kind: 'exit' | 'idle') => void

export class WslOrcadBridgeActivity {
  private readonly live = new Map<string, number>()
  private readonly listeners = new Map<string, Set<ActivityListener>>()
  private readonly lastExitAt = new Map<string, number>()

  constructor(private readonly now: () => number = () => performance.now()) {}

  events(environmentId: string): WslOrcadBridgeChannelEvents {
    const key = environmentId
    return {
      opened: () => this.live.set(key, (this.live.get(key) ?? 0) + 1),
      ended: (byGuest) => {
        const live = Math.max(0, (this.live.get(key) ?? 0) - 1)
        this.live.set(key, live)
        if (live > 0) {
          return
        }
        // orcad exiting ends every socket at once; ending one while another stays open is a
        // normal close, which a WebSocket lets the server finish first, so it reads as guest-ended.
        // Leading-edge cooldown: a burst of one-shot sockets with none held is one verify, not many.
        const last = this.lastExitAt.get(key)
        const exit =
          byGuest && (last === undefined || this.now() - last >= WSL_ORCAD_BRIDGE_EXIT_COOLDOWN_MS)
        if (exit) {
          this.lastExitAt.set(key, this.now())
        }
        for (const listener of Array.from(this.listeners.get(key) ?? [])) {
          listener(exit ? 'exit' : 'idle')
        }
      }
    }
  }

  /** How many of the desktop's sockets to this host are bridged right now. */
  openSockets(environmentId: string): number {
    return this.live.get(environmentId) ?? 0
  }

  /**
   * A watch that fires once when the guest ends the last open bridged socket, proves only while
   * one is open, and reports each time the last one closes any other way (no socket left to prove).
   */
  watch(environmentId: string): WslOrcadWatch {
    const key = environmentId
    const listeners = this.listeners.get(key) ?? new Set<ActivityListener>()
    this.listeners.set(key, listeners)
    let onExit: ((code: number | null) => void) | null = null
    let onIdle: (() => void) | null = null
    const listener: ActivityListener = (kind) => {
      if (kind === 'idle') {
        onIdle?.()
        return
      }
      const exit = onExit
      close()
      exit?.(null)
    }
    const close = (): void => {
      listeners.delete(listener)
      onExit = onIdle = null
    }
    listeners.add(listener)
    return {
      signal: 'ready',
      onExit: (exit) => {
        onExit = exit
      },
      onIdle: (idle) => {
        onIdle = idle
      },
      close,
      proving: () => (this.live.get(key) ?? 0) > 0
    }
  }
}

/** Probes the port with a short-lived bridge, then watches the desktop's own bridged sockets. */
export async function probeThenWatchWslOrcadBridges(
  probe: () => Promise<WslOrcadWatch>,
  activity: WslOrcadBridgeActivity,
  environmentId: string
): Promise<WslOrcadWatch> {
  const probed = await probe()
  if (probed.signal !== 'ready') {
    return probed
  }
  probed.close()
  return activity.watch(environmentId)
}
