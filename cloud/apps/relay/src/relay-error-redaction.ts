// Raw error messages can embed secrets such as connection strings. Only two
// provably inert shapes leave the process: this codebase's snake_case
// invariant slugs, and five-character SQLSTATE codes; everything else is redacted.
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
