/**
 * URL normalization shared by the two npm metadata sources. Registry data
 * is attacker-influencable, so every URL handed to the renderer passes the
 * `https:` allowlist here.
 */

/** Extracts an `https:` URL from a raw string, or `null` for anything else. */
export function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** npm's `repository` field is either a string or `{ type, url }`. */
export function extractRepositoryUrl(repository: unknown): string | null {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? (repository as { url?: unknown }).url
        : null
  return typeof raw === 'string' ? toHttpsUrl(raw.replace(/^git\+/, '')) : null
}
