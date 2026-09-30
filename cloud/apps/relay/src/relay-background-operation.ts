type Warn = (message: string) => void

// A swallowed error hides which sweep step is failing (a silently dead
// cleanup chain stalled production rehoming for hours), but raw messages can
// embed secrets such as connection strings. Only two provably inert shapes
// are logged: this codebase's snake_case invariant slugs, and five-character
// SQLSTATE codes; everything else stays redacted.
function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : ''
  const slug = /^[a-z0-9_]{1,64}$/.test(message) ? message : 'redacted'
  const code = (error as { code?: unknown } | null)?.code
  const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` code=${code}` : ''
  return `${name}: ${slug}${sqlState}`
}

export async function runRelayBackgroundOperation(
  operation: () => Promise<unknown>,
  failureMessage: string,
  warn: Warn = console.warn
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    // Dependency outages must fail readiness without crashing liveness.
    warn(`${failureMessage}: ${describeFailure(error)}`)
  }
}
