import { createHash } from 'node:crypto'
import { normalizeBrowserNavigationUrl } from '../../../shared/browser/navigation/browser-url'
import { pages } from './browser-page-memory-state'

const freshLoads = new WeakMap<Electron.WebContents, { urlDigest: string; load: Promise<void> }>()

export function recordBrowserPageFirstLoad(
  guest: Electron.WebContents,
  url: string,
  load: Promise<void>
): void {
  freshLoads.set(guest, { urlDigest: navigationUrlDigest(url), load })
}

export function claimBrowserPageFirstLoad(
  pageId: string,
  url: string
): { guest: Electron.WebContents; load: Promise<void> } | null {
  const guest = pages.get(pageId)?.guest
  const fresh = guest ? freshLoads.get(guest) : undefined
  if (!guest || !fresh || fresh.urlDigest !== navigationUrlDigest(url)) {
    return null
  }
  freshLoads.delete(guest)
  return { guest, load: fresh.load }
}

function navigationUrlDigest(url: string): string {
  return createHash('sha256')
    .update(normalizeBrowserNavigationUrl(url) ?? url, 'utf16le')
    .digest('hex')
}
