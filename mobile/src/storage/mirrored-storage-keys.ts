import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * The handful of stored keys the app also keeps in memory, for a reader that cannot await one.
 *
 * The hybrid shell is that reader: it hands the page these keys on every `init`, which is built
 * synchronously, so a value it had to read out of the store would always be the one from before
 * the app's last write. Every writer of a mirrored key notes it here as it writes, and the store
 * read below only seats the map, so what a reader is answered with is current at the moment it
 * asks. Which keys those are is the caller's to say: this holds no policy about them.
 */
const mirror = new Map<string, string>()

/** Counts writes, so a store read that started before one cannot land on top of it. */
let writeCount = 0

/** The named keys as they stand. Nothing else can come back, whatever the map happens to hold. */
export function readMirroredStorage(keys: readonly string[]): Readonly<Record<string, string>> {
  const held: Record<string, string> = {}
  for (const key of keys) {
    const value = mirror.get(key)
    if (value !== undefined) {
      held[key] = value
    }
  }
  return held
}

/**
 * Seats the map on the app's store for the named keys.
 *
 * Never rejects: a store that would not answer leaves the last map standing, so a reader is served
 * something stale rather than nothing, and the next ask tries again.
 */
export async function hydrateMirroredStorage(keys: readonly string[]): Promise<void> {
  const startedAt = writeCount
  let pairs: readonly (readonly [string, string | null])[]
  try {
    pairs = await AsyncStorage.multiGet(keys)
  } catch {
    return
  }
  if (writeCount !== startedAt) {
    // A write landed while the read was open, so the read is already behind it. The write stands
    // and the next ask re-reads, rather than this answer putting the older value back.
    return
  }
  for (const [key, value] of pairs) {
    // What was asked for and nothing else: the answer is what a reader is served, so a store that
    // returned a key it was not asked about must not put one in the map.
    if (!keys.includes(key)) {
      continue
    }
    if (value === null) {
      mirror.delete(key)
    } else {
      mirror.set(key, value)
    }
  }
}

/** Notes a write whose caller persists it itself, which is how the app's own writers stay current. */
export function noteMirroredWrite(key: string, value: string | null): void {
  writeCount += 1
  if (value === null) {
    mirror.delete(key)
  } else {
    mirror.set(key, value)
  }
}

/** Noted first, then persisted, because a reader is answered from the map and not from the store. */
export function writeMirroredStorage(key: string, value: string | null): void {
  noteMirroredWrite(key, value)
  void (value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)).catch(
    () => {
      // Nothing is owed to the page for a notify, and a pin that failed to persist is not a reason
      // to take the workspace off screen.
    }
  )
}
