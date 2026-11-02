import AsyncStorage from '@react-native-async-storage/async-storage'

// Shell init is synchronous, so mirror stored keys in memory; page-reachable writes must use persistMirrored.
// Null records a known removal, distinct from an unhydrated key.
const mirror = new Map<string, string | null>()
// writtenAt stamps the last note per owned key so unrelated writes cannot void another key's hydration.
const owners = new Map<string, { count: number; writtenAt: number }>()

let writeCount = 0

export function retainMirroredStorage(keys: readonly string[]): () => void {
  const retained = new Set(keys)
  for (const key of retained) {
    const owner = owners.get(key)
    if (owner) {
      owner.count += 1
    } else {
      owners.set(key, { count: 1, writtenAt: 0 })
    }
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const key of retained) {
      const owner = owners.get(key)
      if (owner && owner.count > 1) {
        owner.count -= 1
      } else {
        owners.delete(key)
        mirror.delete(key)
      }
    }
  }
}

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
export async function hydrateMirroredStorage(keys: readonly string[]): Promise<boolean> {
  const startedAt = writeCount
  const startedOwners = new Map(keys.map((key) => [key, owners.get(key)]))
  let pairs: readonly (readonly [string, string | null])[]
  try {
    pairs = await AsyncStorage.multiGet(keys)
  } catch {
    return keys.every((key) => mirror.has(key))
  }
  for (const [key, value] of pairs) {
    // A store must not inject keys outside the requested route scope.
    const owner = startedOwners.get(key)
    // Writes outrank an overlapping read of their own key; that key keeps the written value.
    if (owner && owners.get(key) === owner && owner.writtenAt <= startedAt) {
      mirror.set(key, value)
    }
  }
  return true
}

// Unlike bulk hydration, preserve store rejection so unavailable storage cannot masquerade as an unset key.
export async function readMirroredKeyOrStore(key: string): Promise<string | null> {
  const held = mirror.get(key)
  return held === undefined ? AsyncStorage.getItem(key) : held
}

type MirroredWriteSource = 'persisted' | 'page'
type MirroredKeyListener = (value: string | null, source: MirroredWriteSource) => void
const keyListeners = new Map<string, Set<MirroredKeyListener>>()

export function subscribeMirroredKey(key: string, listener: MirroredKeyListener): () => void {
  const forKey = keyListeners.get(key) ?? new Set<MirroredKeyListener>()
  keyListeners.set(key, forKey)
  forKey.add(listener)
  return () => {
    forKey.delete(listener)
  }
}

function note(key: string, value: string | null, source: MirroredWriteSource): void {
  writeCount += 1
  const owner = owners.get(key)
  if (owner) {
    owner.writtenAt = writeCount
    mirror.set(key, value)
  }
  for (const listener of keyListeners.get(key) ?? []) {
    listener(value, source)
  }
}

// Mirror only accepted writes; page stores can refuse route keys or oversized values, and callers need the refusal.
export function persistMirrored(key: string, value: string | null): Promise<void> {
  const write = value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)
  // Read back before noting: the page adapter can resolve a refused write, so requested value is not proof of persistence.
  return write
    .then(() => AsyncStorage.getItem(key))
    .then((stored) => {
      note(key, stored, 'persisted')
    })
}

// Native-shell-only: note before async storage so the next synchronous init sees the page’s accepted value.
// Page-reachable writers use persistMirrored because their adapter can refuse writes.
export function writeMirroredStorage(key: string, value: string | null): void {
  // Host-area writes can target unmounted workspace keys; retain their optimistic value until storage lands.
  const release = retainMirroredStorage([key])
  let write: Promise<void>
  try {
    note(key, value, 'page')
    write = value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)
  } catch (error) {
    release()
    throw error
  }
  void write
    .catch(() => {
      // A failed pin persistence must not take the workspace off screen.
    })
    .finally(release)
}
