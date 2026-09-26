import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * The handful of stored keys the app also keeps in memory, for a reader that cannot await one.
 *
 * The hybrid shell is that reader: it hands the page these keys on every `init`, which is built
 * synchronously, so a value it had to read out of the store would always be the one from before
 * the app's last write. Every writer of a mirrored key goes through `persistMirrored` below, which
 * is the only thing that writes this map, and the store read only seats it. Which keys those are
 * is the caller's to say: this holds no policy about them.
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

function note(key: string, value: string | null): void {
  writeCount += 1
  if (value === null) {
    mirror.delete(key)
  } else {
    mirror.set(key, value)
  }
}

/**
 * The one way a mirrored key is written, and the only thing that notes the map (ruling 35).
 *
 * Noted on an accepted write and on nothing else. The store is what accepts: inside the page it is
 * the bridge's adapter, which refuses a key this route was never given and a value past the frame
 * cap, and on the device it is AsyncStorage, which refuses neither. Deciding here rather than in
 * fourteen writers is the whole point — twelve of them noted first and never looked again, so a
 * refused page write left this map holding a value no store had taken and the next `init` handed
 * the page exactly that. There is nothing to undo, because nothing is written until the answer.
 *
 * Returns the store's own promise, so a caller that has something to say about a refusal — the
 * durable send journal is the one — still hears it, and a caller that has not is unchanged.
 */
export function persistMirrored(key: string, value: string | null): Promise<void> {
  const write = value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)
  // Seated from what the store holds afterwards rather than from what was asked for, because a
  // refusal is not always a rejection: the page's adapter resolves a `not-allowed` write and logs
  // it, so a page-closure writer that awaits with no catch does not raise an unhandled rejection
  // in the document. Reading back is what makes the note the store's answer instead of a guess.
  return write
    .then(() => AsyncStorage.getItem(key))
    .then((stored) => {
      note(key, stored)
    })
}

/**
 * The app taking a value the page has already applied, for the one store that cannot refuse one.
 *
 * Noted first here, and that is not a second policy: the shell writes this to the device's own
 * AsyncStorage, which has no allowlist and no frame cap to refuse against, so the answer is known
 * before it is asked for. What the ordering buys is the next `init`, which the shell builds
 * synchronously in the same turn it takes the write — noting on the store's reply instead would
 * hand the page back the value it just changed.
 *
 * Its one caller is the shell's own storage hook, which is native-only; a page-reachable writer
 * belongs on `persistMirrored`, where a refusal is a real possibility. The census beside this
 * module is what holds that to one caller.
 */
export function writeMirroredStorage(key: string, value: string | null): void {
  note(key, value)
  void (value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)).catch(
    () => {
      // Nothing is owed to the page for a notify, and a pin that failed to persist is not a reason
      // to take the workspace off screen.
    }
  )
}
