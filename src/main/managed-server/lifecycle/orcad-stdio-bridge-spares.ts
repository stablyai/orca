import type { RemoteCommandChannel } from '../install/remote-install-transport'
import type { OrcadStdioBridgeMode } from './orcad-stdio-bridge-script'

export type OrcadStdioBridgeOpenedChannel = {
  channel: RemoteCommandChannel
  mode: OrcadStdioBridgeMode
}

/** How many bridge channels to keep opened ahead of demand, and for how long after listening. */
export type OrcadStdioBridgeSparePolicy = { spares: number; windowMs: number }

export type OrcadStdioBridgeSpares = {
  /** A live channel opened ahead of time, or null when none is ready. */
  take(): OrcadStdioBridgeOpenedChannel | null
  stop(): void
}

/**
 * A fresh connection dials several sockets back to back (status, control, session tabs, terminal
 * stream), and each one waits for its own bridge child to start. Spares opened ahead of those
 * dials take that start off the path; the window keeps the pool from outliving the startup burst.
 */
export function createOrcadStdioBridgeSpares(
  openChannel: () => Promise<OrcadStdioBridgeOpenedChannel>,
  policy: OrcadStdioBridgeSparePolicy,
  closeChannel: (channel: RemoteCommandChannel) => void
): OrcadStdioBridgeSpares {
  const ready: OrcadStdioBridgeOpenedChannel[] = []
  let pending = 0
  let open = true
  const drop = (opened: OrcadStdioBridgeOpenedChannel): void => {
    const index = ready.indexOf(opened)
    if (index !== -1) {
      ready.splice(index, 1)
    }
  }
  const fill = (): void => {
    while (open && ready.length + pending < policy.spares) {
      pending += 1
      openChannel().then(
        (opened) => {
          pending -= 1
          if (!open) {
            closeChannel(opened.channel)
            return
          }
          ready.push(opened)
          // A child that exited unused (refused, or idled out) must not be handed to a socket.
          opened.channel.once('close', () => drop(opened))
        },
        () => {
          // No refill on failure: the next socket opens its own channel and reports the error.
          pending -= 1
        }
      )
    }
  }
  const stop = (): void => {
    open = false
    clearTimeout(timer)
    for (const opened of ready.splice(0)) {
      closeChannel(opened.channel)
    }
  }
  const timer = setTimeout(stop, policy.windowMs)
  timer.unref?.()
  fill()
  return {
    take: () => {
      const opened = ready.shift() ?? null
      if (opened) {
        fill()
      }
      return opened
    },
    stop
  }
}
