import type { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'

/** Resolves once the session's background startup read has landed, faulted, or been ended. */
export async function claudeStartupSettled(
  adapter: ClaudeStructuredSessionAdapter,
  sessionId: string
): Promise<void> {
  // Element access reaches the adapter's private map, which no production caller needs.
  await adapter['sessions'].get(sessionId)?.startup.settled
}
