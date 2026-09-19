import { useLocalSearchParams } from 'expo-router'
import { MobileAgentSessionHistoryPanel } from '../../../../src/agent-history/MobileAgentSessionHistoryPanel'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { useMobileWebShellEnabled } from '../../../../src/mobile-web-shell/use-mobile-web-shell-enabled'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

/**
 * Agent session history, from the desktop's bundle or from this app.
 *
 * The switch is `index.tsx`'s, for its reasons: the shell renders the page only for a route the
 * bundle lists with grants this app implements, `fallback` is what a negotiation that said no
 * falls back to, and a settling flag read renders the native panel because a store build never
 * reaches storage at all.
 *
 * Two dynamic segments rather than one, so both are encoded: `useLocalSearchParams` answers the
 * decoded value, and a worktree id or a deep-linked host id carrying `/`, `?`, `#` or whitespace
 * would otherwise stop being the single segment `matchesRoutePattern` reads it as. A route with no
 * worktree names no screen the shell could open, so it stays native.
 */
export default function MobileAgentSessionHistoryScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const enabled = useMobileWebShellEnabled()
  const panel = (
    <MobileAgentSessionHistoryPanel hostId={hostId} worktreeId={worktreeId} name={name} />
  )

  if (enabled !== true || !hostId || !worktreeId) {
    return panel
  }
  return (
    <MobileWebShellScreen
      hostId={hostId}
      route={{
        pathname: `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent(worktreeId)}`,
        // Omitted rather than empty: the page reads the label off the search half, and a `name=`
        // with nothing after it is a label, where an absent one lets the panel derive its own.
        ...(name === '' ? {} : { params: { name } })
      }}
      fallback={panel}
    />
  )
}
