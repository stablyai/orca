// A file's text kept briefly after a read, so `drive read --offset` pages through the same text
// instead of fetching and converting the whole file again for every page.
const TTL_MS = 5 * 60_000
const MAX_FILES = 8

type Entry = { text: string; source: string; at: number }
const entries = new Map<string, Entry>()

/** The text for this version of the file, made once and reused for a few minutes. */
export async function cachedFileText(
  key: { account: string; id: string; modifiedTime?: string },
  make: () => Promise<{ text: string; source: string }>,
  now = Date.now()
): Promise<{ text: string; source: string }> {
  // No modified time means no way to tell versions apart, so nothing is kept.
  if (!key.modifiedTime) {
    return make()
  }
  const name = `${key.account}\n${key.id}\n${key.modifiedTime}`
  const hit = entries.get(name)
  if (hit && now - hit.at < TTL_MS) {
    return hit
  }
  const made = { ...(await make()), at: now }
  entries.delete(name)
  entries.set(name, made)
  for (const [old, entry] of entries) {
    if (entries.size <= MAX_FILES && now - entry.at < TTL_MS) {
      break
    }
    entries.delete(old)
  }
  return made
}
