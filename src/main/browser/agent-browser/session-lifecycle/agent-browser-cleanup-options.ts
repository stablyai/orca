// Cleanup must finish within the 20s quit barrier.
export const AGENT_BROWSER_CLEANUP_TIMEOUT_MS = 5_000

export type AgentBrowserCleanupOptions = {
  closeTimeoutMs?: number
  /** Preserve queued commands for the replacement session. */
  keepQueuedCommands?: boolean
}
