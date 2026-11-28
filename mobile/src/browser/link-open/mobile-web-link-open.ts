import { openExternalLink } from '../../platform/external-links/external-link'
import type { MobileLinkOpenMode } from '../../storage/preferences'
import { isLoopbackHttpUrl } from '../../../../src/shared/workspace/ports/localhost-worktree-labels'

/**
 * Where a web link tapped in terminal output or chat opens. The phone's browser stands in
 * wherever no Orca browser tab can open (see useOpenUrlInOrca).
 */
export function openMobileWebLink(
  url: string,
  mode: MobileLinkOpenMode,
  openInOrca: ((url: string) => void) | undefined,
  ask: (url: string) => void
): void {
  // Why: a loopback URL names the host that printed it; the phone's own browser would load the phone.
  if (openInOrca && isLoopbackHttpUrl(url)) {
    openInOrca(url)
  } else if (mode === 'ask') {
    ask(url)
  } else if (mode === 'orca-browser' && openInOrca) {
    openInOrca(url)
  } else {
    openExternalLink(url)
  }
}
