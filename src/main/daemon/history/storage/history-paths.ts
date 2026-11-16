export function getHistorySessionDirName(sessionId: string): string {
  // Encode session IDs containing slashes or colons into portable directory names.
  return encodeURIComponent(sessionId)
}
