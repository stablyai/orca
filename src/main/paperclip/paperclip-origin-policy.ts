export type PaperclipOriginPolicy = { origin: string }

export function parsePaperclipOrigin(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Enter an absolute local Paperclip HTTP origin.')
  }
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !isLiteralLoopbackHost(url.hostname)
  ) {
    throw new Error(
      'Paperclip must use a literal loopback HTTP origin with no path or credentials.'
    )
  }
  return url
}

export function createPaperclipOriginPolicy(origin: string): PaperclipOriginPolicy {
  return { origin: parsePaperclipOrigin(origin).origin }
}

export function buildPaperclipApiUrl(
  policy: PaperclipOriginPolicy,
  segments: readonly string[],
  query?: Readonly<Record<string, string | number | undefined>>
): string {
  const url = new URL(`/api/${segments.map(encodeURIComponent).join('/')}`, policy.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

function isLiteralLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1') {
    return true
  }
  const octets = normalized.split('.').map(Number)
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  )
}
