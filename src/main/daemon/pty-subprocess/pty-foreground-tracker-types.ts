import type { AgentForegroundProcessResolution } from '../../providers/foreground/agent-process'
import type { ForegroundAgentIdentity } from '../sessions/session-subprocess-handle'

// identifiedAt: no later than the lookup that found it; a process created after it cannot be that agent.
export type CachedAgentForeground = {
  processName: string
  pid: number | null
  refreshedAt: number
  identifiedAt: number
  /** Windows: the agent's own creation time, when the lookup read it. */
  creationTimeMs?: number
}

export type AgentForegroundAnchor = Pick<
  AgentForegroundProcessResolution,
  'processId' | 'processCreationTimeMs'
>

export function toCachedAgentForeground(
  processName: string,
  found: AgentForegroundAnchor | null,
  identifiedAt: number
): CachedAgentForeground {
  const pid = found?.processId ?? null
  const cached: CachedAgentForeground = { processName, pid, refreshedAt: Date.now(), identifiedAt }
  if (pid !== null && found?.processCreationTimeMs !== undefined) {
    cached.creationTimeMs = found.processCreationTimeMs
  }
  return cached
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
