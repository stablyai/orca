import type { AuthenticatedMobileSocket } from './mobile-socket-wiring'
import {
  IDLE_PASSIVE_CLIENT_CAPABILITY,
  IDLE_PASSIVE_CONTROL_CLIENT_CAPABILITY
} from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { ORCAD_DECLARE_CLIENT_METHOD } from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-peer-desktops-contract'
import { DECLARE_ORCA_ACCOUNT_METHOD } from '../../../../shared/remote-runtime/pairing/paired-desktop-account-contract'

type CapabilityHolder = Pick<AuthenticatedMobileSocket, 'clientCapabilities'>

/** A socket that declared it only watches (keep-awake on a WSL host); idle exit ignores it. */
export function isIdlePassiveSocket(socket: CapabilityHolder | undefined): boolean {
  return socket?.clientCapabilities.includes(IDLE_PASSIVE_CLIENT_CAPABILITY) === true
}

/** A desktop's control socket: open alone it doesn't hold idle exit; its ordinary requests do. */
export function isIdlePassiveControlSocket(socket: CapabilityHolder | undefined): boolean {
  return socket?.clientCapabilities.includes(IDLE_PASSIVE_CONTROL_CLIENT_CAPABILITY) === true
}

export function countIdleBlockingConnections<Socket>(
  connections: Iterable<Socket>,
  authenticated: (socket: Socket) => CapabilityHolder | undefined
): number {
  let count = 0
  for (const socket of connections) {
    const capabilities = authenticated(socket)
    if (!isIdlePassiveSocket(capabilities) && !isIdlePassiveControlSocket(capabilities)) {
      count += 1
    }
  }
  return count
}

// Bookkeeping a desktop sends on its own, not work the user asked for: status reads (the 30 s
// quiet-socket heartbeat and the capability and health reads behind every call), connect-time
// declarations, and its 30 s presence report.
const DESKTOP_BOOKKEEPING_METHODS: ReadonlySet<string> = new Set([
  'status.get',
  ORCAD_DECLARE_CLIENT_METHOD,
  DECLARE_ORCA_ACCOUNT_METHOD,
  'notifications.reportDesktopPresence'
])
// Exempt messages are small; a bigger one is treated as use rather than parsed twice.
const EXEMPT_MESSAGE_MAX_CHARS = 16 * 1024

/**
 * Whether a passive socket's message is not use: the bookkeeping above, requests the desktop
 * tagged background, and every streaming method (a subscription would otherwise hold the host for
 * as long as it stays open).
 */
export function isIdleExemptControlMessage(
  plaintext: string,
  isStreamingMethod: (method: string) => boolean
): boolean {
  if (plaintext.length > EXEMPT_MESSAGE_MAX_CHARS) {
    return false
  }
  let request: unknown
  try {
    request = JSON.parse(plaintext)
  } catch {
    return false
  }
  if (typeof request !== 'object' || request === null || !('method' in request)) {
    return false
  }
  const { method } = request
  if (typeof method !== 'string') {
    return false
  }
  // The desktop tagged it background traffic (a poll); a user's own requests carry no tag.
  return (
    ('idlePassive' in request && request.idlePassive === true) ||
    DESKTOP_BOOKKEEPING_METHODS.has(method) ||
    isStreamingMethod(method)
  )
}
