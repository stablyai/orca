import AsyncStorage from '@react-native-async-storage/async-storage'

// Shell init is synchronous, so mirror stored keys in memory; page-reachable writes must use persistMirrored.
// Null records a known removal, distinct from an unhydrated key.
const mirror = new Map<string, string | null>()

let writeCount = 0

export function readMirroredStorage(keys: readonly string[]): Readonly<Record<string, string>> {
  const held: Record<string, string> = {}
  for (const key of keys) {
    const value = mirror.get(key)
    if (typeof value === 'string') {
      held[key] = value
    }
  }
  return held
}

// Failed hydration retains the last mirror for synchronous readers and retries on the next ask.
export async function hydrateMirroredStorage(keys: readonly string[]): Promise<void> {
  const startedAt = writeCount
  let pairs: readonly (readonly [string, string | null])[]
  try {
    pairs = await AsyncStorage.multiGet(keys)
  } catch {
    return
  }
  if (writeCount !== startedAt) {
    // Writes outrank an overlapping read; discard its stale snapshot and reread next time.
    return
  }
  for (const [key, value] of pairs) {
    // A store must not inject keys outside the requested route scope.
    if (keys.includes(key)) {
      mirror.set(key, value)
    }
  }
}

// Unlike bulk hydration, preserve store rejection so unavailable storage cannot masquerade as an unset key.
export async function readMirroredKeyOrStore(key: string): Promise<string | null> {
  const held = mirror.get(key)
  return held === undefined ? AsyncStorage.getItem(key) : held
}

type MirroredKeyListener = (value: string | null) => void
const keyListeners = new Map<string, Set<MirroredKeyListener>>()

export function subscribeMirroredKey(key: string, listener: MirroredKeyListener): () => void {
  const forKey = keyListeners.get(key) ?? new Set<MirroredKeyListener>()
  keyListeners.set(key, forKey)
  forKey.add(listener)
  return () => {
    forKey.delete(listener)
  }
}

function note(key: string, value: string | null): void {
  writeCount += 1
  mirror.set(key, value)
  for (const listener of keyListeners.get(key) ?? []) {
    listener(value)
  }
}

// Mirror only accepted writes; page stores can refuse route keys or oversized values, and callers need the refusal.
export function persistMirrored(key: string, value: string | null): Promise<void> {
  const write = value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)
  // Read back before noting: the page adapter can resolve a refused write, so requested value is not proof of persistence.
  return write
    .then(() => AsyncStorage.getItem(key))
    .then((stored) => {
      note(key, stored)
    })
}

// Native-shell-only: note before async storage so the next synchronous init sees the page’s accepted value.
// Page-reachable writers use persistMirrored because their adapter can refuse writes.
export function writeMirroredStorage(key: string, value: string | null): void {
  note(key, value)
  void (value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)).catch(
    () => {
      // A failed pin persistence must not take the workspace off screen.
    }
  )
}
