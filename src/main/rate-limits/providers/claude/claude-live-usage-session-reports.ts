import type { RateLimitWindow } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { isSameClaudeUsageReset, isSameClaudeUsageWindow } from './claude-usage-window'

export type ClaudeLiveUsageWindowKind = 'session' | 'weekly'

type ResetWindow = { resetsAt: number; adoptedBy: Set<string> }

type SessionReport = {
  configDir: string | null
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

function resetWindowKey(configDir: string | null, kind: ClaudeLiveUsageWindowKind): string {
  return JSON.stringify([configDir, kind])
}

// Bounds memory to recently posting sessions; an evicted one needs one more post before changes count.
const MAX_TRACKED_CLAUDE_SESSIONS = 64

// A session learns quota only from its own API responses, so its reports are ordered while sessions' are not.
export class ClaudeLiveUsageSessionReports {
  private readonly lastBySession = new Map<string, SessionReport>()
  // Keyed by account and window kind; each account keeps its reset until that window ends.
  private readonly resetByWindow = new Map<string, ResetWindow>()

  private lastWindow(
    sessionId: string | null,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind
  ): RateLimitWindow | null {
    const last = sessionId === null ? undefined : this.lastBySession.get(sessionId)
    return last?.configDir === configDir ? last[kind] : null
  }

  hasChanged(
    sessionId: string | null,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow
  ): boolean {
    const previous = this.lastWindow(sessionId, configDir, kind)
    return Boolean(previous && !isSameClaudeUsageWindow(previous, incoming))
  }

  // Usage only grows within a window, so a session's own drop is a redeemed reset.
  // Other sessions dropping to it later are adopting that reset, not redeeming another.
  recordReset(
    sessionId: string | null,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow
  ): boolean {
    const previous = this.lastWindow(sessionId, configDir, kind)
    if (
      sessionId === null ||
      !previous ||
      previous.resetsAt === null ||
      incoming.resetsAt === null ||
      !isSameClaudeUsageReset(previous.resetsAt, incoming.resetsAt) ||
      incoming.usedPercent >= previous.usedPercent
    ) {
      return false
    }
    const key = resetWindowKey(configDir, kind)
    const recorded = this.resetByWindow.get(key)
    if (
      recorded &&
      isSameClaudeUsageReset(recorded.resetsAt, incoming.resetsAt) &&
      !recorded.adoptedBy.has(sessionId)
    ) {
      recorded.adoptedBy.add(sessionId)
      return false
    }
    this.resetByWindow.set(key, { resetsAt: incoming.resetsAt, adoptedBy: new Set([sessionId]) })
    return true
  }

  remember(
    sessionId: string,
    configDir: string | null,
    report: Pick<SessionReport, ClaudeLiveUsageWindowKind>
  ): void {
    const last = this.lastBySession.get(sessionId)
    const kept = last?.configDir === configDir ? last : null
    this.lastBySession.delete(sessionId)
    this.lastBySession.set(sessionId, {
      configDir,
      // Partial posts omit a window without retracting the session's last report for it.
      session: report.session ?? kept?.session ?? null,
      weekly: report.weekly ?? kept?.weekly ?? null
    })
    for (const oldest of this.lastBySession.keys()) {
      if (this.lastBySession.size <= MAX_TRACKED_CLAUDE_SESSIONS) {
        break
      }
      this.lastBySession.delete(oldest)
    }
  }

  // After a reset, idle sessions still hold the pre-reset value for the same window.
  isResetWindow(
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow,
    now: number
  ): boolean {
    const reset = this.resetByWindow.get(resetWindowKey(configDir, kind))
    return Boolean(
      reset && reset.resetsAt > now && isSameClaudeUsageReset(reset.resetsAt, incoming.resetsAt)
    )
  }
}
