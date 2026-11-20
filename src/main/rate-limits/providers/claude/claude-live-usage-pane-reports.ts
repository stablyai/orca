import type { RateLimitWindow } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { isSameClaudeUsageReset, isSameClaudeUsageWindow } from './claude-usage-window'

export type ClaudeLiveUsageWindowKind = 'session' | 'weekly'

type PaneReport = {
  configDir: string | null
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

type ResetWindow = { configDir: string | null; resetsAt: number }

// Bounds memory to recently posting panes; an evicted pane needs one more post before changes count.
const MAX_TRACKED_CLAUDE_PANES = 64

// A pane learns quota only from its own API responses, so a changed report is fresh even when lower.
export class ClaudeLiveUsagePaneReports {
  private readonly lastByPane = new Map<string, PaneReport>()
  private readonly resetByKind = new Map<ClaudeLiveUsageWindowKind, ResetWindow>()

  hasChanged(
    paneKey: string,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow
  ): boolean {
    const last = this.lastByPane.get(paneKey)
    const previous = last?.configDir === configDir ? last[kind] : null
    return Boolean(previous && !isSameClaudeUsageWindow(previous, incoming))
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

  markReset(configDir: string | null, kind: ClaudeLiveUsageWindowKind, resetsAt: number): void {
    this.resetByKind.set(kind, { configDir, resetsAt })
  }

  // After a reset, idle panes still hold the pre-reset value for the same window.
  isResetWindow(
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow,
    now: number
  ): boolean {
    const reset = this.resetByKind.get(kind)
    return Boolean(
      reset &&
      reset.configDir === configDir &&
      reset.resetsAt > now &&
      isSameClaudeUsageReset(reset.resetsAt, incoming.resetsAt)
    )
  }
}
