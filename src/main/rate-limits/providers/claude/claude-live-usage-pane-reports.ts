import type { RateLimitWindow } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { isSameClaudeUsageReset, isSameClaudeUsageWindow } from './claude-usage-window'

export type ClaudeLiveUsageWindowKind = 'session' | 'weekly'

type PaneReport = {
  configDir: string | null
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

function resetWindowKey(configDir: string | null, kind: ClaudeLiveUsageWindowKind): string {
  return JSON.stringify([configDir, kind])
}

// Bounds memory to recently posting panes; an evicted pane needs one more post before changes count.
const MAX_TRACKED_CLAUDE_PANES = 64

// A pane learns quota only from its own API responses, so its reports are ordered while panes' are not.
export class ClaudeLiveUsagePaneReports {
  private readonly lastByPane = new Map<string, PaneReport>()
  // Keyed by account and window kind; each account keeps its reset until that window ends.
  private readonly resetsAtByWindow = new Map<string, number>()

  private lastWindow(
    paneKey: string | null,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind
  ): RateLimitWindow | null {
    const last = paneKey === null ? undefined : this.lastByPane.get(paneKey)
    return last?.configDir === configDir ? last[kind] : null
  }

  hasChanged(
    paneKey: string | null,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow
  ): boolean {
    const previous = this.lastWindow(paneKey, configDir, kind)
    return Boolean(previous && !isSameClaudeUsageWindow(previous, incoming))
  }

  // Usage only grows within a window, so a pane's own drop is a redeemed reset.
  recordReset(
    paneKey: string | null,
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow
  ): boolean {
    const previous = this.lastWindow(paneKey, configDir, kind)
    if (
      !previous ||
      previous.resetsAt === null ||
      incoming.resetsAt === null ||
      !isSameClaudeUsageReset(previous.resetsAt, incoming.resetsAt) ||
      incoming.usedPercent >= previous.usedPercent
    ) {
      return false
    }
    this.resetsAtByWindow.set(resetWindowKey(configDir, kind), incoming.resetsAt)
    return true
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

  // After a reset, idle panes still hold the pre-reset value for the same window.
  isResetWindow(
    configDir: string | null,
    kind: ClaudeLiveUsageWindowKind,
    incoming: RateLimitWindow,
    now: number
  ): boolean {
    const resetsAt = this.resetsAtByWindow.get(resetWindowKey(configDir, kind))
    return (
      resetsAt !== undefined &&
      resetsAt > now &&
      isSameClaudeUsageReset(resetsAt, incoming.resetsAt)
    )
  }
}
