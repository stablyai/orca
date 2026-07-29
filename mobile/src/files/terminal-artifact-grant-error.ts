// Why: the runtime rejects stale terminal-artifact grants with these codes, but
// the RPC mux flattens error shapes to code+message strings, so mobile matches
// by substring. Single source so grant refresh and preview errors can't drift.
export function isTerminalArtifactGrantError(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('terminal_file_grant_expired') ||
    normalized.includes('terminal_file_grant_mismatch') ||
    normalized.includes('terminal_file_grant_stale')
  )
}
