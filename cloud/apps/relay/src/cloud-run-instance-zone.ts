const INSTANCE_ZONE_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/zone'
const REQUEST_TIMEOUT_MS = 3_000

// The metadata server answers `projects/<number>/zones/<zone>`. Undefined on any failure:
// the zone only labels log lines, so it must never hold up or fail a boot.
export async function readCloudRunInstanceZone(
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(INSTANCE_ZONE_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      return undefined
    }
    const zone = (await response.text()).trim().split('/').at(-1)
    return zone && /^[a-z0-9-]+$/.test(zone) ? zone : undefined
  } catch {
    return undefined
  }
}
