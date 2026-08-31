import { randomUUID } from 'node:crypto'
import { readOrCreateBrowserHostClientId } from './browser-host-client-identity'

let browserHostClientId: string | null = null

/**
 * Resolves the durable hosting id from the active profile. App startup calls this before it opens
 * a window, because window creation stamps the id into the renderer's argv and cannot wait.
 */
export function initializeBrowserClientHostId(profileDirectory: string): void {
  if (browserHostClientId) {
    // Why not overwrite: a renderer already carries the earlier value, and two ids for one host
    // means the renderer stops recognizing the pages it is hosting.
    console.warn('[browser-client-host] hosting identity was read before startup resolved it')
    return
  }
  browserHostClientId = readOrCreateBrowserHostClientId(profileDirectory)
}

/**
 * The id every browser-host lease this app takes out is minted under, and therefore the id a page's
 * placement carries when the guest runs in this app's own renderer rather than another client's.
 *
 * Its own module so window creation can stamp it into a renderer's argv without pulling in the
 * client-host runtime graph.
 */
export function getBrowserClientHostId(): string {
  // Why a mint rather than a throw: without a resolved profile the id is only process-local, which
  // costs tab survival across a relaunch but still hosts every page of this session.
  browserHostClientId ??= randomUUID()
  return browserHostClientId
}
