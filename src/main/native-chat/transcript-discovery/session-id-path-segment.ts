// Ids become path segments; a separator or dot segment would escape the history root.
export function isSafeSessionIdPathSegment(sessionId: string): boolean {
  return (
    sessionId !== '.' &&
    sessionId !== '..' &&
    !sessionId.includes('/') &&
    !sessionId.includes('\\') &&
    !sessionId.includes('\0')
  )
}
