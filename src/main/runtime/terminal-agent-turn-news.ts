// The source lifetime composes the same completion interpreter as the window.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentTurnEndedOnPurpose } from '../../shared/agent-main-agent-verdict'
import { createHookOnlyCompletionObserver } from '../../renderer/src/components/terminal-pane/agent-completion-hook-only-observer'
import type {
  AgentCompletionHookCandidate,
  AgentCompletionStatusSnapshot
} from '../../renderer/src/components/terminal-pane/agent-completion-coordinator-types'
import type { AgentCompletionIdentityScope } from '../../renderer/src/components/terminal-pane/agent-completion-identity-store'
import { createAgentHookNotificationRetirement } from '../../renderer/src/hooks/agent-hook-notification-retirement'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { LiveNotificationRetirement } from '../../shared/notification-settings-types'

type PaneNews = {
  worktreeId: string
  source: string
  observer: ReturnType<typeof createHookOnlyCompletionObserver>
  retirement?: ReturnType<typeof createAgentHookNotificationRetirement>
}

export type TerminalAgentTurnNewsItem = {
  paneKey: string
  worktreeId: string
  row: AgentStatusIpcPayload
}

export type TerminalAgentTurnNewsDelivery = TerminalAgentTurnNewsItem & {
  snapshot: AgentCompletionStatusSnapshot
}

export type TerminalAgentTurnNewsDeps = {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  deliver: (news: TerminalAgentTurnNewsDelivery) => string | undefined
  retire?: (alerts: LiveNotificationRetirement[]) => void
  createIdentityScope?: (paneKey: string) => AgentCompletionIdentityScope
  /** Opt-in: a turn began (a prompt went in), told at once. */
  started?: (news: TerminalAgentTurnNewsItem) => void
  /** Opt-in: a turn its user stopped or a newer request replaced, which is otherwise no news. */
  stopped?: (news: TerminalAgentTurnNewsItem) => void
}

export class TerminalAgentTurnNews {
  private readonly newsByPane = new Map<string, PaneNews>()
  private readonly titleWorking = new Set<string>()

  constructor(private readonly deps: TerminalAgentTurnNewsDeps) {}

  observe(change: AgentPaneChange): void {
    const { paneKey } = change
    if (change.kind === 'seeded') {
      this.newsByPane.get(paneKey)?.observer.clearPendingHookDone()
      if (change.phase !== 'rest') {
        const row = this.deps.readHookRow(paneKey)
        const news = row ? this.sourceFor(change, row) : undefined
        if (news && row) {
          if (row.turnCompletedAt !== undefined) {
            news.observer.rememberTurnCompletedAt(row.turnCompletedAt)
          }
          if (row.state === 'working') {
            news.observer.seedHookStatus(row)
          }
        }
      }
      return
    }
    if (change.kind === 'observed') {
      const row = this.deps.readHookRow(paneKey)
      if (!row) {
        this.forget(paneKey)
        return
      }
      const news = this.sourceFor(change, row)
      if (change.phase === 'working' && row.state === 'working') {
        news?.observer.observeHookStatus(row)
      }
      return
    }
    this.tellOptIn(change)
    if (change.to === 'rest') {
      this.forget(paneKey)
      return
    }
    if (
      change.transition === 'turn-finished' ||
      change.transition === 'errored' ||
      change.transition === 'needs-input'
    ) {
      const row = this.deps.readHookRow(paneKey)
      if (row) {
        this.sourceFor(change, row)?.observer.observeHookStatus(row)
      }
    } else {
      this.newsByPane.get(paneKey)?.observer.clearPendingHookDone()
    }
  }

  observeNotification(change: AgentPaneChange): void {
    const { paneKey } = change
    const row = this.deps.readHookRow(paneKey)
    if (change.kind === 'moved' || !row) {
      if (
        !row &&
        ((change.kind === 'moved' && change.to === 'working') ||
          (change.kind === 'seeded' && change.phase === 'working'))
      ) {
        this.titleWorking.add(paneKey)
      }
      if (change.kind === 'moved' && change.to === 'rest') {
        this.titleWorking.delete(paneKey)
        this.forget(paneKey)
      }
      if (!row && change.kind === 'observed') {
        this.forget(paneKey)
      }
      return
    }
    const previous = this.newsByPane.get(paneKey)
    const workingObserved = this.titleWorking.has(paneKey)
    const news = this.sourceFor(change, row)
    if (!news) {
      return
    }
    if (
      news !== previous &&
      change.kind === 'observed' &&
      row.state === 'done' &&
      row.turnEndDisposition === undefined &&
      !workingObserved
    ) {
      news.observer.seedHookStatus(row)
      return
    }
    if (change.kind === 'seeded' || row.isReplay || row.restoredUnconfirmed) {
      news.retirement?.clear()
      news.observer.seedHookStatus(row)
    } else {
      news.retirement?.observe(row)
      news.observer.observeHookStatus(row)
    }
  }

  private sourceFor(change: AgentPaneChange, row: AgentStatusIpcPayload): PaneNews | undefined {
    const { paneKey } = change
    if (!change.workspace || row.structuredHost) {
      this.forget(paneKey)
      return
    }
    if (row.providerSessionOnly || row.programStatusOnly) {
      return
    }
    const worktreeId = change.workspace.worktreeId
    const source = JSON.stringify([
      worktreeId,
      row.connectionId,
      row.terminalHandle,
      row.runId,
      row.executionId,
      row.authorityRestartId,
      row.agentType
    ])
    let news = this.newsByPane.get(paneKey)
    if (news?.source !== source) {
      this.forget(paneKey)
      const workingObserved = this.titleWorking.delete(paneKey)
      const retirement = this.deps.retire
        ? createAgentHookNotificationRetirement(() => row.terminalHandle ?? null, this.deps.retire)
        : undefined
      const entry: PaneNews = {
        source,
        worktreeId,
        retirement,
        observer: createHookOnlyCompletionObserver({
          paneKey,
          workingObserved,
          identityScope: this.deps.createIdentityScope?.(paneKey),
          isLive: () =>
            this.newsByPane.get(paneKey) === entry && this.deps.readHookRow(paneKey) !== null,
          dispatch: (candidate) => this.deliver(paneKey, entry, candidate)
        })
      }
      this.newsByPane.set(paneKey, entry)
      news = entry
    }
    return news
  }

  private tellOptIn(change: Extract<AgentPaneChange, { kind: 'moved' }>): void {
    const { paneKey, workspace } = change
    if (change.transition === 'prompt-submitted' && this.deps.started) {
      const row = this.deps.readHookRow(paneKey)
      if (row && !row.structuredHost) {
        this.deps.started({ paneKey, worktreeId: workspace.worktreeId, row })
      }
    }
    if (change.to === 'rest' && change.from !== 'rest' && this.deps.stopped) {
      const row = this.deps.readHookRow(paneKey)
      if (row?.state === 'done' && !row.structuredHost && agentTurnEndedOnPurpose(row)) {
        this.deps.stopped({ paneKey, worktreeId: workspace.worktreeId, row })
      }
    }
  }

  private forget(paneKey: string): void {
    const news = this.newsByPane.get(paneKey)
    news?.observer.dispose()
    news?.retirement?.clear()
    this.newsByPane.delete(paneKey)
  }

  dispose(): void {
    for (const paneKey of this.newsByPane.keys()) {
      this.forget(paneKey)
    }
    this.titleWorking.clear()
  }

  private deliver(paneKey: string, news: PaneNews, candidate: AgentCompletionHookCandidate): void {
    const notificationId = this.deps.deliver({
      paneKey,
      worktreeId: news.worktreeId,
      row: candidate.originalRow,
      snapshot: candidate.snapshot
    })
    if (notificationId) {
      news.retirement?.record({ notificationId }, candidate.snapshot)
    }
  }
}
