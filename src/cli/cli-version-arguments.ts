// Why: eager and dependency-free so `orca --version` stays off the runtime-client graph.
export function isVersionRequest(argv: readonly string[]): { json: boolean } | null {
  const versionFlags = argv.filter((arg) => arg === '--version' || arg === '-v')
  const rest = argv.filter((arg) => arg !== '--version' && arg !== '-v')
  if (versionFlags.length !== 1 || rest.some((arg) => arg !== '--json') || rest.length > 1) {
    return null
  }
  return { json: rest.length === 1 }
}
