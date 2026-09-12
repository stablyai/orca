const pending = new Map<string, Promise<unknown>>()

/**
 * Serializes parses of one transcript path.
 *
 * Two callers really do overlap on the same file: a forced refresh aborts the
 * running scan while its in-flight parse keeps going as the replacement scan
 * starts it again, and `session-title-file-reader.ts` parses on its own, with
 * no scan involved. Overlapping reads share the cached resume point's message
 * channel, so the second `beginRead` would drop the first read's consumers and
 * the first `finishRead` would hand them the wrong outcome; the later store
 * could also move the cursor backwards.
 */
export async function inSessionParseFileLane<T>(path: string, parse: () => Promise<T>): Promise<T> {
  const previous = pending.get(path)
  const run = (async () => {
    await previous?.catch(() => undefined)
    return parse()
  })()
  pending.set(path, run)
  try {
    return await run
  } finally {
    if (pending.get(path) === run) {
      pending.delete(path)
    }
  }
}
