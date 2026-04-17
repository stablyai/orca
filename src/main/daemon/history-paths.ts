export function getHistorySessionDirName(sessionId: string): string {
  // Why: real session IDs embed worktree identity and can contain characters
  // such as `:` and `/` that are invalid in a Windows path segment. Persist
  // history under an encoded directory name so crash recovery works cross-
  // platform without changing the user-visible session ID.
  return encodeURIComponent(sessionId)
}
