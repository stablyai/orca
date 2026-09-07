import type { ConnectionVerdict } from '../transport/connection-health'
import type { ConnectionState } from '../transport/types'
import type { MobileSessionTabStripPreview } from './mobile-session-tab-strip-entries'

/**
 * What the session screen should draw while the phone is not yet serving live tabs.
 *
 * - `live`: real tabs are mounted (or the host has confirmed there are none). The existing
 *   loading/empty/content branches own the screen.
 * - `reconnecting-with-cache`: nothing live yet, but this workspace's last strip is on the
 *   device. Draw it, disabled, with a compact progress line instead of a bare spinner.
 * - `offline`: the retry loop has given up or the pairing is rejected. A stale strip would
 *   imply a session we cannot reach, so fall back to the existing offline affordance.
 * - `blocking`: nothing live and nothing cached. Unchanged from before this state existed.
 */
export type MobileSessionReconnectViewState =
  | { kind: 'live' }
  | { kind: 'reconnecting-with-cache'; preview: MobileSessionTabStripPreview; label: string }
  | { kind: 'offline' }
  | { kind: 'blocking' }

export function selectMobileSessionReconnectViewState(args: {
  connState: ConnectionState
  verdictKind: ConnectionVerdict['kind']
  terminalsLoaded: boolean
  liveTabCount: number
  activeHandle: string | null
  cachedPreview: MobileSessionTabStripPreview | null
}): MobileSessionReconnectViewState {
  const { connState, verdictKind, terminalsLoaded, liveTabCount, activeHandle, cachedPreview } =
    args
  // A mounted terminal or tab is the real thing; a mid-session drop must never trade it for a
  // snapshot of itself, however the connection is faring.
  if (liveTabCount > 0 || activeHandle !== null) {
    return { kind: 'live' }
  }
  // The host has answered and said this workspace is empty — that is live truth, not a gap.
  if (connState === 'connected' && terminalsLoaded) {
    return { kind: 'live' }
  }
  if (verdictKind === 'unreachable' || verdictKind === 'auth-failed') {
    return { kind: 'offline' }
  }
  if (cachedPreview && cachedPreview.tabs.length > 0) {
    return {
      kind: 'reconnecting-with-cache',
      preview: cachedPreview,
      label: reconnectProgressLabel(connState)
    }
  }
  return { kind: 'blocking' }
}

function reconnectProgressLabel(connState: ConnectionState): string {
  if (connState === 'connected') {
    return 'Loading tabs…'
  }
  return connState === 'reconnecting' || connState === 'disconnected'
    ? 'Reconnecting…'
    : 'Connecting…'
}
