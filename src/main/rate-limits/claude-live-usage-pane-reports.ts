import type { RateLimitWindow } from '../../shared/rate-limit-types'
import { isSameClaudeUsageReset, isSameClaudeUsageWindow } from './claude-usage-window'

export type ClaudeLiveUsageWindowKind = 'session' | 'weekly'

type PaneReport = {
  configDir: string | null
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

type FreshReport = { configDir: string | null; window: RateLimitWindow }

// Bounds memory to recently posting panes; an evicted pane needs one more post before changes count.
export const MAX_TRACKED_CLAUDE_PANES = 64

// A pane learns quota only from its own API responses, so a changed report is fresh even when lower.
export class ClaudeLiveUsagePaneReports {
  private readonly lastByPane = new Map<string, PaneReport>()
  private readonly freshByKind = new Map<ClaudeLiveUsageWindowKind, FreshReport>()

  hasChanged(
    paneKey: string,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow | null
  ): boolean {
    const last = this.lastByPane.get(paneKey)
    const previous = last?.configDir === configDir ? last[kind] : null
    return Boolean(previous && incoming && !isSameClaudeUsageWindow(previous, incoming))
  }

  remember(
    paneKey: string,
    configDir: string | null,
    report: Pick<PaneReport, ClaudeLiveUsageWindowKind>
  ): void {
    const last = this.lastByPane.get(paneKey)
    const kept = last?.configDir === configDir ? last : null
    this.lastByPane.delete(paneKey)
    this.lastByPane.set(paneKey, {
      configDir,
      // Partial posts omit a window without retracting the pane's last report for it.
      session: report.session ?? kept?.session ?? null,
      weekly: report.weekly ?? kept?.weekly ?? null
    })
    for (const oldest of this.lastByPane.keys()) {
      if (this.lastByPane.size <= MAX_TRACKED_CLAUDE_PANES) {
        break
      }
      this.lastByPane.delete(oldest)
    }
  }

  markFresh(
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    window: RateLimitWindow
  ): void {
    // Without a reset the window cannot be identified or expire, so it cannot pin anything.
    if (window.resetsAt === null) {
      return
    }
    this.freshByKind.set(kind, { configDir, window })
  }

  // After a fresh report, first posts and unchanged repeats cannot replace it within its window.
  isPinnedAgainst(
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow,
    now: number
  ): boolean {
    const fresh = this.freshByKind.get(kind)
    if (!fresh || fresh.configDir !== configDir || fresh.window.resetsAt === null) {
      return false
    }
    return (
      fresh.window.resetsAt > now &&
      isSameClaudeUsageReset(fresh.window.resetsAt, incoming.resetsAt)
    )
  }
}
