const METADATA_IDENTITY_ENDPOINT =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
const METADATA_IDENTITY_TIMEOUT_MS = 5_000

export async function googleMetadataIdentityToken(
  audience: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const endpoint = new URL(METADATA_IDENTITY_ENDPOINT)
  endpoint.searchParams.set('audience', audience)
  endpoint.searchParams.set('format', 'full')
  const response = await fetchImpl(endpoint, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(METADATA_IDENTITY_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`metadata_identity_${response.status}`)
  const token = (await response.text()).trim()
  if (token.length === 0 || token.length > 16 * 1024) {
    throw new Error('metadata_identity_invalid')
  }
  return token
}

// Google identity tokens live an hour; minting one per request would be a metadata read each.
// A failed mint is never reused.
export function reusedIdentityToken(
  mint: () => Promise<string>,
  now: () => number = Date.now,
  reuseMs = 10 * 60_000
): () => Promise<string> {
  let token: { value: Promise<string>; at: number } | undefined
  return () => {
    const at = now()
    if (!token || at - token.at > reuseMs) {
      const value = mint()
      token = { value, at }
      value.catch(() => {
        if (token?.value === value) token = undefined
      })
    }
    return token.value
  }
}
