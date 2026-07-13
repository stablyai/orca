export function isMissingRemoteRefGitError(error: unknown): boolean {
  // Why: Node's execFile prefixes the rejection `.message` with
  // `Command failed: git fetch <remote> …`, which does NOT include git's
  // `fatal: couldn't find remote ref …` line. That diagnostic lives in
  // `.stderr` (attached by the git runner). Inspecting both is what lets the
  // multi-remote PR resolver distinguish a genuinely-missing ref (walk the
  // next remote) from auth/network failures (surface immediately).
  if (!error || typeof error !== 'object') {
    return false
  }
  const e = error as { message?: unknown; stderr?: unknown }
  const message = typeof e.message === 'string' ? e.message : String(error)
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  const normalized = `${message}\n${stderr}`.toLowerCase()
  return (
    normalized.includes('could not find remote ref') ||
    normalized.includes("couldn't find remote ref")
  )
}
