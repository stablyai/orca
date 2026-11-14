import { BoundedMap } from '../../shared/bounded-map'

const MAX_REMEMBERED_SESSIONS = 256

// Only Claude's statusline knows the window; its session file does not record it.
const windowBySession = new BoundedMap<string, number>({ maxEntries: MAX_REMEMBERED_SESSIONS })

export function noteClaudeSessionWindow(sessionId: string, windowTokens: number): void {
  windowBySession.set(sessionId, windowTokens)
}

export function claudeSessionWindowTokens(sessionId: string): number | null {
  return windowBySession.get(sessionId) ?? null
}
