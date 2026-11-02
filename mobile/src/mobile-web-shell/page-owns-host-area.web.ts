import { usePageBridgeClientIfPresent } from '../transport/client-context.web'

/** The `ownsHostArea` init fact, never the page's own width: a detail-pane page sits beside the
 *  shell's sidebar. Read in render: the page mounts after `init`. */
export function usePageOwnsHostArea(): boolean {
  return usePageBridgeClientIfPresent()?.getShellSession()?.ownsHostArea === true
}
