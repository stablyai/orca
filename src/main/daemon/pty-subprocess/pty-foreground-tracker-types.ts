import type { ForegroundAgentIdentity } from '../sessions/session-subprocess-handle'

// identifiedAt: no later than the lookup that found it; a process created after it cannot be that agent.
export type CachedAgentForeground = {
  processName: string
  pid: number | null
  refreshedAt: number
  identifiedAt: number
}

export type PtyForegroundProcessTracker = {
  recordOutput(data: string): void
  markDead(): void
  /** rawFallback bypasses cached identity and process-table refreshes for cheap polling. */
  getForegroundProcess(options?: { rawFallback?: boolean; cachedOnly?: boolean }): string | null
  confirmForegroundProcess(context?: { decision?: boolean }): Promise<string | null>
  confirmShellForeground(): Promise<boolean>
  cachedAgent(): ForegroundAgentIdentity | null
  pendingForegroundRefresh(): Promise<unknown> | null
}
