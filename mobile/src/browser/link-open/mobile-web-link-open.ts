import { openExternalLink } from '../../platform/external-links/external-link'
import type { MobileLinkOpenMode } from '../../storage/preferences'

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
  if (mode === 'ask') {
    ask(url)
  } else if (mode === 'orca-browser' && openInOrca) {
    openInOrca(url)
  } else {
    openExternalLink(url)
  }
}
