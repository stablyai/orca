// Raw messages may contain secrets; emit only invariant slugs or SQLSTATE codes and redact everything else.
export function relayErrorSlug(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ''
  return /^[a-z0-9_]{1,64}$/.test(message) ? message : null
}

export function describeRelayFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` code=${code}` : ''
  return `${name}: ${relayErrorSlug(error) ?? 'redacted'}${sqlState}`
}
