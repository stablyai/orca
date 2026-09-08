const pending = new Map<string, Promise<unknown>>()

/** Keep cache cursors and index appends ordered across backfill and list scans. */
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
