import {
  claimSpareDocument,
  prepareSpareDocument
} from '../../modules/orca-mobile-web-shell/src/spare-documents'
import { generationDirectoryPath } from './generation-store-file-system'
import { deriveHostCacheKey } from './host-cache-key'
import { mintShellSessionId } from './shell-session-id'
import { processGenerationStore } from './process-generation-store'

// The build the last accepted prepare parked, until a claim takes it. Native may since have dropped it
// (background, memory); this only spares an entry the native call when nothing of its build is there.
let parkedBuildId: string | null = null

// Boot one page from the host's cached build and park it, so the next native entry on any host with
// that build skips the WebView's start and the page's script parse. `replace` lets a spare of another
// build go; without it a parked spare stays. Native also declines on small phones and with two
// documents live.
export async function prewarmSpareShellDocument(hostId: string, replace: boolean): Promise<void> {
  try {
    const hostKey = deriveHostCacheKey(hostId)
    const active = await processGenerationStore().readActiveGeneration(hostKey)
    if (active === null) {
      return
    }
    const parked = await prepareSpareDocument(
      active.buildId,
      hostKey,
      generationDirectoryPath(active.directory),
      mintShellSessionId(),
      replace
    )
    if (parked) {
      parkedBuildId = active.buildId
    }
  } catch {
    // A spare only saves time; the entry boots its own document without one.
  }
}

// The parked spare's session id when it holds this build; the view mounted with it adopts that page.
export async function claimSpareShellSessionId(
  buildId: string,
  hostKey: string,
  directory: string
): Promise<string | null> {
  if (parkedBuildId !== buildId) {
    return null
  }
  try {
    const sessionId = await claimSpareDocument(buildId, hostKey, directory)
    if (sessionId !== null) {
      parkedBuildId = null
    }
    return sessionId
  } catch {
    return null
  }
}
