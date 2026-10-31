/** GETs a public JSON file with a byte cap and timeout; no cookies, no query, no identifiers. */
export async function fetchBoundedJson(
  fetcher: typeof fetch,
  url: string,
  { label, maxBytes, timeoutMs }: { label: string; maxBytes: number; timeoutMs: number }
): Promise<unknown> {
  const response = await fetcher(url, {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`)
  }
  const declaredBytes = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`${label} response exceeds its size limit`)
  }
  if (!response.body) {
    throw new Error(`${label} response has no body`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    totalBytes += chunk.value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new Error(`${label} response exceeds its size limit`)
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new Error(
      `invalid ${label} response: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
