import { usePageBridgeClientIfPresent } from '../transport/client-context.web'

// Read init ownership, never page width: a wide detail pane may still sit beside the native sidebar. Render starts after init.
export function usePageOwnsHostArea(): boolean {
  return usePageBridgeClientIfPresent()?.getShellSession()?.ownsHostArea === true
}
