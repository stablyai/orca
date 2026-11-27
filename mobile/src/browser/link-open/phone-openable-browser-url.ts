import { resolveRemoteFailureExternalUrl } from '../../../../src/shared/browser/navigation/browser-url'
import { isBlankBrowserUrl } from '../pane-view/browser-url'
import { canOpenExternalLink } from '../../platform/external-links/external-link'

/** As desktop's streamed pane: only a public URL, since a local one names the host, not the phone. */
export function phoneOpenableBrowserUrl(url: string): string | null {
  if (isBlankBrowserUrl(url)) {
    return null
  }
  const external = resolveRemoteFailureExternalUrl(url)
  return external && canOpenExternalLink(external) ? external : null
}
