import AsyncStorage from '@react-native-async-storage/async-storage'

// After any v2 success, refuse legacy downgrade on every path; key by the pinned, nonsecret host public key.
const STORAGE_KEY = 'orca:e2ee-v2-hosts'
const MAX_LATCHED_HOSTS = 128

let latched: Set<string> | null = null
const pendingLatches = new Set<string>()
let hydration: Promise<void> | null = null
let writeChain: Promise<void> = Promise.resolve()

export function hydrateE2EEV2HostLatch(): Promise<void> {
  hydration ??= (async () => {
    let stored: string[]
    try {
      stored = parseLatchedHosts(await AsyncStorage.getItem(STORAGE_KEY))
    } catch {
      // Why: unreadable is not "nothing latched" — stay unknown (no fallback) and retry later.
      hydration = null
      return
    }
    latched = new Set(stored)
    if (pendingLatches.size > 0) {
      for (const key of pendingLatches) {
        latched.add(key)
      }
      pendingLatches.clear()
      persist()
    }
  })()
  return hydration
}

// null = not hydrated yet; callers must then treat the host as latched.
export function isHostLatchedToE2EEV2(hostPublicKeyB64: string): boolean | null {
  if (pendingLatches.has(hostPublicKeyB64)) {
    return true
  }
  return latched ? latched.has(hostPublicKeyB64) : null
}

export function latchHostToE2EEV2(hostPublicKeyB64: string): void {
  if (!hostPublicKeyB64) {
    return
  }
  if (!latched) {
    pendingLatches.add(hostPublicKeyB64)
    void hydrateE2EEV2HostLatch()
    return
  }
  if (latched.has(hostPublicKeyB64)) {
    return
  }
  latched.add(hostPublicKeyB64)
  persist()
}

export function resetE2EEV2HostLatchForTests(): void {
  latched = null
  pendingLatches.clear()
  hydration = null
  writeChain = Promise.resolve()
}

function persist(): void {
  const snapshot = [...(latched ?? [])].slice(-MAX_LATCHED_HOSTS)
  writeChain = writeChain
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)))
    .catch(() => {
      // The in-memory latch still applies for this app session.
    })
}

function parseLatchedHosts(raw: string | null): string[] {
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    return []
  }
}
