import type { WebSocket } from 'ws'
import type { AuthorizationIncarnation } from '../../../../shared/authorization-incarnation'
import type { DeviceRegistry } from '../server/pairing/device-registry'

/** Observe registry changes even when authenticated sockets are idle. */
export class PairedSocketAuthorities {
  private readonly refresh: ReturnType<typeof setInterval>
  private readonly cleanups = new Map<WebSocket, () => void>()

  constructor(registry: DeviceRegistry) {
    this.refresh = setInterval(() => {
      try {
        registry.refreshAuthority()
      } catch (error) {
        console.error('[runtime] Failed to refresh device authority:', error)
      }
    }, 1_000)
    this.refresh.unref?.()
  }

  bind(ws: WebSocket, authority: AuthorizationIncarnation, revoke: () => void): boolean {
    authority.signal.addEventListener('abort', revoke, { once: true })
    this.cleanups.set(ws, () => authority.signal.removeEventListener('abort', revoke))
    if (authority.signal.aborted) {
      revoke()
      return false
    }
    return true
  }

  unbind(ws: WebSocket): void {
    this.cleanups.get(ws)?.()
    this.cleanups.delete(ws)
  }

  dispose(): void {
    clearInterval(this.refresh)
    for (const cleanup of this.cleanups.values()) {
      cleanup()
    }
    this.cleanups.clear()
  }
}

/** Final authorized host handoff: bytes already sent cannot be retracted before a client learns of revocation. */
export function pairedAuthorityReply(
  reply: (response: string) => void,
  authority: AuthorizationIncarnation | null | undefined
): (response: string) => void {
  return (response) => {
    if (!authority?.signal.aborted) {
      reply(response)
    }
  }
}
