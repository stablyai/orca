import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileWebShellReachability } from './mobile-web-shell-session-contract'

/**
 * The host's connection state as the three answers a step in the shell session needs.
 *
 * `reconnecting` is unreachable, not connecting, and that is the whole point of the distinction: a
 * host whose desktop is gone never settles on `disconnected`. The client dials, fails, schedules a
 * retry and cycles `connecting` -> `reconnecting` -> `connecting` with the delay growing to a
 * minute, so treating `reconnecting` as "still dialling" leaves a phone with a perfectly good
 * cached workspace spinning forever. `connecting` alone is the first dial, which is worth the wait
 * because it usually succeeds; a scheduled retry after a failure is evidence the host is not there.
 */
export function readMobileWebShellReachability(
  connState: ConnectionState,
  client: RpcClient | null
): MobileWebShellReachability {
  if (connState === 'connected') {
    return client === null ? 'connecting' : 'connected'
  }
  return connState === 'connecting' || connState === 'handshaking' ? 'connecting' : 'unreachable'
}
