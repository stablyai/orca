// Why: persist the data needed to render the home page so cold-start /
// resume-from-background paints instantly with the last known good
// values, then updates in place when fresh RPC data arrives. Without
// this, Resume and Account-usage cards flash empty for ~1s while the
// WebSocket reconnects and the first responses come back.
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { stringifyMobileOutboundJson } from '../transport/mobile-outbound-json'

const STORAGE_KEY = 'orca:home-snapshot:v1'
export const HOME_SNAPSHOT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024

type WorktreeSummary = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
}

type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: WorktreeSummary | null
}

export type HomeSnapshot = {
  worktreeInfo: Record<string, HostWorktreeInfo>
  accountsByHost: Record<string, AccountsSnapshot>
  savedAt: number
}

let memoryCache: HomeSnapshot | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

export async function loadHomeSnapshot(): Promise<HomeSnapshot | null> {
  if (memoryCache) {
    return memoryCache
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    if (
      raw.length > HOME_SNAPSHOT_MAX_SERIALIZED_BYTES ||
      utf8ByteLengthExceeds(raw, HOME_SNAPSHOT_MAX_SERIALIZED_BYTES)
    ) {
      return null
    }
    const parsed = JSON.parse(raw) as HomeSnapshot
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.worktreeInfo !== 'object' ||
      typeof parsed.accountsByHost !== 'object'
    ) {
      return null
    }
    memoryCache = parsed
    return parsed
  } catch {
    return null
  }
}

// Why: throttle writes so a flurry of streamed account-snapshot updates
// (one per provider fetch finishing) doesn't hammer AsyncStorage.
export function saveHomeSnapshot(snapshot: HomeSnapshot): void {
  let serialized: string
  try {
    serialized = stringifyMobileOutboundJson(snapshot, HOME_SNAPSHOT_MAX_SERIALIZED_BYTES)
  } catch {
    return
  }
  memoryCache = snapshot
  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  writeTimer = setTimeout(() => {
    writeTimer = null
    void AsyncStorage.setItem(STORAGE_KEY, serialized).catch(() => {})
  }, 250)
}

function utf8ByteLengthExceeds(value: string, limit: number): boolean {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
    if (bytes > limit) {
      return true
    }
  }
  return false
}

/** Test-only: clear the process-lifetime snapshot and delayed write. */
export function resetHomeSnapshotCacheForTests(): void {
  memoryCache = null
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
}
