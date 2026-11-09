import {
  claimSpareDocument,
  discardSpareDocument,
  prepareSpareDocument
} from '../../modules/orca-mobile-web-shell/src/spare-document'
import type { GenerationStore } from './generation-store'
import { generationDirectoryPath } from './generation-store-file-system'
import { deriveHostCacheKey } from './host-cache-key'
import { mintShellSessionId } from './shell-session-id'

// A Home entry claims the spare about 0.2 s after the tap on a simulator; a native screen keeps it no longer.
const HOME_SPARE_CLAIM_GRACE_MS = 2000

// What JS last asked native to park, until a claim or a drop. Native may since have dropped it on
// its own (background, memory); this only saves the claim's native round trip when nothing can match.
let parkedDirectory: string | null = null
let dropTimer: ReturnType<typeof setTimeout> | null = null
// A prepare still reading the store when Home goes must not park a spare after the drop ran.
let homeShown = false

function cancelDrop(): void {
  if (dropTimer !== null) {
    clearTimeout(dropTimer)
    dropTimer = null
  }
}

// Boot one page from the first of `hostIds` (most recently connected first) that has a cached build.
export async function prepareHomeSparePage(
  store: GenerationStore,
  hostIds: readonly string[]
): Promise<void> {
  try {
    for (const hostId of hostIds) {
      const hostKey = deriveHostCacheKey(hostId)
      const active = await store.readActiveGeneration(hostKey)
      if (active === null) {
        continue
      }
      if (!homeShown) {
        return
      }
      const directory = generationDirectoryPath(active.directory)
      const prepared = await prepareSpareDocument(directory, mintShellSessionId())
      if (prepared && !homeShown) {
        await dropHomeSparePage()
      } else if (prepared) {
        parkedDirectory = directory
      }
      return
    }
  } catch {
    // A spare only saves time; the next entry boots its own page without one.
  }
}

// The spare's session id when Home booted it from `directory`; the view mounted with it adopts that page.
export async function claimHomeSparePage(directory: string): Promise<string | null> {
  if (parkedDirectory !== directory) {
    return null
  }
  parkedDirectory = null
  cancelDrop()
  try {
    return await claimSpareDocument(directory)
  } catch {
    return null
  }
}

// Home is shown; a spare still inside the grace after leaving it stays.
export function enterHomeSparePage(): void {
  homeShown = true
  cancelDrop()
}

// Home lost focus: a page opening from it claims the spare within the grace, anything else drops it.
export function leaveHomeSparePage(): void {
  homeShown = false
  cancelDrop()
  dropTimer = setTimeout(() => {
    dropTimer = null
    void dropHomeSparePage()
  }, HOME_SPARE_CLAIM_GRACE_MS)
}

// Also runs before any host's built files go: that is rare, and a spare must not outlive its files.
export function dropHomeSparePage(): Promise<void> {
  parkedDirectory = null
  return discardSpareDocument().catch(() => undefined)
}
