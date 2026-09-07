// Why: reconnecting to a workspace the phone opened a minute ago tears the session screen back
// to an empty strip and a spinner, even though the tab list it is about to be handed is the one
// it just displayed. Persist the shape of the strip per workspace so a reconnect paints the
// known tabs immediately and swaps in live rows under the same keys.
//
// This file is the authority on what reaches plaintext storage, not its callers: every entry is
// rebuilt field by field on the way in, and shell-controlled titles are replaced with fixed
// labels here rather than trusted to have been scrubbed upstream.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import {
  getPersistableTabStripTitle,
  isDrawableTabStripType,
  type MobileSessionTabStripEntry,
  type MobileSessionTabStripPreview
} from '../session/mobile-session-tab-strip-entries'

const STORAGE_KEY = 'orca:session-tab-strip:v1'
// A phone realistically revisits a handful of workspaces; the caps bound both the stored blob
// and the cost of a single write.
const MAX_WORKSPACES = 12
const MAX_TABS_PER_WORKSPACE = 24
const MAX_TITLE_LENGTH = 64
const WRITE_DEBOUNCE_MS = 250
// 128 bits of a digest: far past collision range for a dozen workspaces, and short enough that
// the stored blob stays small.
const WORKSPACE_DIGEST_LENGTH = 32

type StoredWorkspace = { key: string; preview: MobileSessionTabStripPreview }
type StoredFile = { workspaces: StoredWorkspace[] }

// Insertion-ordered, so the first key is the least recently written one to evict.
let memoryCache: Map<string, MobileSessionTabStripPreview> | null = null
let loadPromise: Promise<Map<string, MobileSessionTabStripPreview>> | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * A workspace id ends in a filesystem path, so it is digested rather than stored. The host id
 * stays readable because forgetting a host has to be able to find that host's rows, and because
 * host ids already key several other entries in this store.
 */
export function getSessionTabStripCacheKey(
  hostId: string | undefined,
  worktreeId: string | undefined
): string | null {
  if (!hostId || !worktreeId) {
    return null
  }
  return JSON.stringify([hostId, digestWorkspaceId(worktreeId)])
}

/** Whatever this process already knows, with no await — so a revisit paints on the first frame. */
export function readCachedSessionTabStrip(key: string | null): MobileSessionTabStripPreview | null {
  if (!key || !memoryCache) {
    return null
  }
  return memoryCache.get(key) ?? null
}

export async function loadCachedSessionTabStrip(
  key: string | null
): Promise<MobileSessionTabStripPreview | null> {
  if (!key) {
    return null
  }
  const cache = await loadFile()
  return cache.get(key) ?? null
}

export function saveCachedSessionTabStrip(
  key: string | null,
  preview: MobileSessionTabStripPreview
): void {
  if (!key) {
    return
  }
  const redacted = redactPreview(preview)
  const cache = memoryCache ?? new Map()
  memoryCache = cache
  // Map.set on an existing key keeps its original iteration position, so delete first to make
  // the re-inserted key the newest and give the cap true LRU eviction.
  cache.delete(key)
  cache.set(key, redacted)
  while (cache.size > MAX_WORKSPACES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
  scheduleWrite(cache)
}

/**
 * Drop every workspace belonging to a host the user has unpaired. Both the in-memory rows and
 * the stored blob have to go: leaving either behind means the next save for any other host
 * serializes the forgotten host's tabs straight back to disk.
 */
export async function deleteCachedSessionTabStripForHost(hostId: string): Promise<void> {
  // Load first so the rewrite below preserves other hosts. If storage is unreadable we still
  // rewrite, which can cost another host its rows — the wrong direction for a cache, the right
  // one for a deletion the user asked for.
  const cache = await loadFile()
  // Deleting the entry the iterator is standing on is well-defined for a Map.
  for (const key of cache.keys()) {
    if (readHostIdFromKey(key) === hostId) {
      cache.delete(key)
    }
  }
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  await writeFile(cache)
}

export function resetSessionTabStripCacheForTests(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  memoryCache = null
  loadPromise = null
}

function digestWorkspaceId(worktreeId: string): string {
  const digest = sha256(new TextEncoder().encode(worktreeId))
  let hex = ''
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex.slice(0, WORKSPACE_DIGEST_LENGTH)
}

function readHostIdFromKey(key: string): string | null {
  try {
    const parsed = JSON.parse(key) as unknown
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null
  } catch {
    return null
  }
}

async function loadFile(): Promise<Map<string, MobileSessionTabStripPreview>> {
  if (memoryCache) {
    return memoryCache
  }
  loadPromise ??= (async () => {
    const parsed = await readStoredFile()
    // A save that landed while the read was in flight owns the newer truth.
    const cache = memoryCache ?? new Map<string, MobileSessionTabStripPreview>()
    for (const workspace of parsed) {
      if (!cache.has(workspace.key)) {
        cache.set(workspace.key, workspace.preview)
      }
    }
    memoryCache = cache
    return cache
  })()
  return loadPromise
}

async function readStoredFile(): Promise<StoredWorkspace[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as StoredFile
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.workspaces)) {
      return []
    }
    return parsed.workspaces.flatMap((workspace) => {
      if (typeof workspace?.key !== 'string' || !Array.isArray(workspace.preview?.tabs)) {
        return []
      }
      return [{ key: workspace.key, preview: redactPreview(workspace.preview) }]
    })
  } catch {
    return []
  }
}

// Why: a flurry of snapshots (one per desktop republication) must not hammer AsyncStorage.
function scheduleWrite(cache: Map<string, MobileSessionTabStripPreview>): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  writeTimer = setTimeout(() => {
    writeTimer = null
    void writeFile(cache)
  }, WRITE_DEBOUNCE_MS)
}

async function writeFile(cache: Map<string, MobileSessionTabStripPreview>): Promise<void> {
  const workspaces: StoredWorkspace[] = [...cache].map(([key, preview]) => ({ key, preview }))
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaces })).catch(() => {})
}

// Rebuilt field by field so a field later added to the live tab type cannot ride into storage
// without someone deciding it belongs there.
function redactPreview(preview: MobileSessionTabStripPreview): MobileSessionTabStripPreview {
  const tabs: MobileSessionTabStripEntry[] = []
  for (const tab of preview.tabs ?? []) {
    if (typeof tab?.id !== 'string' || !isDrawableTabStripType(tab.type)) {
      continue
    }
    const agentId = typeof tab.agentId === 'string' ? tab.agentId : null
    const title = typeof tab.title === 'string' ? tab.title : ''
    tabs.push({
      id: tab.id,
      type: tab.type,
      title: getPersistableTabStripTitle({ type: tab.type, title, agentId }).slice(
        0,
        MAX_TITLE_LENGTH
      ),
      agentId
    })
    if (tabs.length === MAX_TABS_PER_WORKSPACE) {
      break
    }
  }
  const activeTabId =
    typeof preview.activeTabId === 'string' && tabs.some((tab) => tab.id === preview.activeTabId)
      ? preview.activeTabId
      : null
  return { tabs, activeTabId }
}
