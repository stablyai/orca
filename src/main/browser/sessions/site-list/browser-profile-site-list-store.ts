import { readFileSync } from 'node:fs'
import { browserSessionRegistry } from '../profiles/browser-session-registry'
import {
  parseAllowedHosts,
  persistBrowserSessionMeta
} from '../profiles/browser-session-meta-store'
import {
  replaceBrowserProfileSiteLists,
  setBrowserProfileSiteList
} from './browser-session-site-list'

const metadataPath = (): string => browserSessionRegistry.metadataPath

// True when the startup read failed. Enforcement is then off (nothing is loaded) and edits are
// refused, so a later save can never rewrite the file from lists that were never read.
let startupReadFailed = false

/** Lists on disk, or null when the file exists but cannot be read or parsed. A missing file is empty. */
function readListsFromDisk(): Record<string, string[]> | null {
  try {
    const data = JSON.parse(readFileSync(metadataPath(), 'utf-8'))
    return parseAllowedHosts(data?.allowedHostsByProfileId)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : null
  }
}

/** Startup: enforce the saved lists (one retry). Must run before any profile session binds. */
export function loadPersistedBrowserProfileSiteLists(): boolean {
  const lists = readListsFromDisk() ?? readListsFromDisk()
  startupReadFailed = lists === null
  if (lists) {
    replaceBrowserProfileSiteLists(lists)
  }
  return lists !== null
}

/** False while the saved lists are unreadable; each call retries a failed startup read. */
export function areBrowserProfileSiteListsReadable(): boolean {
  return !startupReadFailed || loadPersistedBrowserProfileSiteLists()
}

/**
 * Merges the edit into the lists currently on disk and writes that, so another profile's list is
 * never lost. Memory changes only after the write worked, so memory and disk never disagree.
 */
export function saveBrowserProfileSiteList(
  profileId: string,
  entries: string[]
): 'saved' | 'unreadable' | 'write-failed' {
  const onDisk = readListsFromDisk()
  if (onDisk === null) {
    return 'unreadable'
  }
  const next: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(onDisk)) {
    // Lists of deleted profiles are dropped here, matching what deleting a profile does on disk.
    if (id !== profileId && browserSessionRegistry.getProfile(id)) {
      next[id] = list
    }
  }
  if (entries.length > 0) {
    next[profileId] = entries
  }
  const saved = persistBrowserSessionMeta(metadataPath, browserSessionRegistry.defaultPartition, {
    allowedHostsByProfileId: next
  })
  if (!saved) {
    return 'write-failed'
  }
  setBrowserProfileSiteList(profileId, entries)
  return 'saved'
}
