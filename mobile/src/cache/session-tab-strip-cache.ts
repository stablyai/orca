// Why: reconnecting to a workspace the phone opened a minute ago tears the session screen back
// to an empty strip and a spinner, even though the tab list it is about to be handed is the one
// it just displayed. Persist the drawn fields of the strip per workspace so a reconnect paints
// the known tabs immediately and swaps in live rows under the same keys.
import AsyncStorage from '@react-native-async-storage/async-storage'
import type {
  MobileSessionTabStripEntry,
  MobileSessionTabStripPreview
} from '../session/mobile-session-tab-strip-entries'

const STORAGE_KEY = 'orca:session-tab-strip:v1'
// A phone realistically revisits a handful of workspaces; the caps bound both the stored blob
// and the cost of a single write.
const MAX_WORKSPACES = 12
const MAX_TABS_PER_WORKSPACE = 24
const MAX_TITLE_LENGTH = 64
const WRITE_DEBOUNCE_MS = 250

type StoredWorkspace = { key: string; preview: MobileSessionTabStripPreview }
type StoredFile = { workspaces: StoredWorkspace[] }

// Insertion-ordered, so the first key is the least recently written one to evict.
let memoryCache: Map<string, MobileSessionTabStripPreview> | null = null
let loadPromise: Promise<Map<string, MobileSessionTabStripPreview>> | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

export function getSessionTabStripCacheKey(
  hostId: string | undefined,
  worktreeId: string | undefined
): string | null {
  if (!hostId || !worktreeId) {
    return null
  }
  // A worktree id ends in a filesystem path, which on Linux and macOS may hold any byte except
  // NUL — so join through JSON rather than pick a separator and hope.
  return JSON.stringify([hostId, worktreeId])
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

export function resetSessionTabStripCacheForTests(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  memoryCache = null
  loadPromise = null
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
    const workspaces: StoredWorkspace[] = [...cache].map(([key, preview]) => ({ key, preview }))
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaces })).catch(() => {})
  }, WRITE_DEBOUNCE_MS)
}

// Rebuilt field by field so a field later added to the live tab type cannot ride into storage
// without someone deciding it belongs there.
function redactPreview(preview: MobileSessionTabStripPreview): MobileSessionTabStripPreview {
  const tabs: MobileSessionTabStripEntry[] = []
  for (const tab of preview.tabs ?? []) {
    if (typeof tab?.id !== 'string' || typeof tab.type !== 'string') {
      continue
    }
    tabs.push({
      id: tab.id,
      type: tab.type,
      title: typeof tab.title === 'string' ? tab.title.slice(0, MAX_TITLE_LENGTH) : '',
      agentId: typeof tab.agentId === 'string' ? tab.agentId : null
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
