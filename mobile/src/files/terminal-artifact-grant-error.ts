// The RPC mux flattens grant errors to code+message; share substring matching so refresh and preview errors agree.
export function isTerminalArtifactGrantError(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('terminal_file_grant_expired') ||
    normalized.includes('terminal_file_grant_mismatch') ||
    normalized.includes('terminal_file_grant_stale')
  )
}
