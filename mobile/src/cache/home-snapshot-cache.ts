// Seed cold-start/resume cards from persisted last-good snapshot, then update via RPC; avoids ~1s empty flash while reconnecting.
import AsyncStorage from '@react-native-async-storage/async-storage'
// Persist canonical countsProvenAt so rehydrated counts retain freshness evidence.
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'

const STORAGE_KEY = 'orca:home-snapshot:v1'

export type HomeSnapshot = {
  worktreeInfo: Record<string, HostWorktreeInfo>
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
    const parsed = JSON.parse(raw) as HomeSnapshot
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.worktreeInfo !== 'object' ||
      parsed.worktreeInfo === null
    ) {
      return null
    }
    memoryCache = parsed
    return parsed
  } catch {
    return null
  }
}

// Throttle AsyncStorage writes during per-provider streamed snapshot bursts.
export function saveHomeSnapshot(snapshot: HomeSnapshot): void {
  memoryCache = snapshot
  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  writeTimer = setTimeout(() => {
    writeTimer = null
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {})
  }, 250)
}
