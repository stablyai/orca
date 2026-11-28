import { useSyncExternalStore } from 'react'
import { usePageBridgeClientIfPresent } from '../../transport/connection/client-context.web'

const NO_SUBSCRIPTION = () => () => {}

// Read init ownership, never page width: a wide detail pane may still sit beside the native sidebar.
// Subscribed, since a fold that hands the page the host area lands in an init after the resize render.
export function usePageOwnsHostArea(): boolean {
  const client = usePageBridgeClientIfPresent()
  return useSyncExternalStore(
    client?.onHostAreaUpdate ?? NO_SUBSCRIPTION,
    () => client?.getShellSession()?.ownsHostArea === true
  )
}
