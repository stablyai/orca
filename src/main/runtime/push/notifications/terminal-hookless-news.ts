// Times title-only agent finishes and bells as a window's terminal pane does, so a windowless host tells its phones the same news.
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { TerminalSideEffectFact } from '../../../../shared/terminal/output/terminal-side-effect-facts'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
} from '../../../../shared/notifications/terminal-notification-timing'

type Timer = { cancel: () => void }

export type TerminalHooklessNewsItem = {
  paneKey: string
  worktreeId: string
  executionHostId: ExecutionHostId | null
}

export type TerminalHooklessNewsDeps = {
  hasHookRow: (paneKey: string) => boolean
  /** A hook finish the hook lane is still waiting out. */
  hasPendingHookFinish: (paneKey: string) => boolean
  /** A completion yields its burst's bell only when it would alert itself. */
  completionAlertsEnabled: () => boolean
  /** `title` is the idle title that ended the turn, as the window words it. */
  deliverTitleFinish: (news: TerminalHooklessNewsItem, title: string) => void
  deliverBell: (news: TerminalHooklessNewsItem) => void
  setTimer: (run: () => void, delayMs: number) => Timer
  now: () => number
}

export class TerminalHooklessNews {
  private readonly pendingFinishByPane = new Map<string, Timer>()
  private readonly bellTimerByPane = new Map<string, Timer>()
  // A bell waiting on its burst's completion; it rings if work resumes instead.
  private readonly deferredBellByPane = new Map<string, TerminalHooklessNewsItem>()
  // When each pane last announced a turn end; a BEL in that burst belongs to it.
  private readonly finishedAtByPane = new Map<string, number>()

  constructor(private readonly deps: TerminalHooklessNewsDeps) {}

  /** One chunk's facts, in order: the title tracker's working/idle edges, then its bell. */
  noteFacts(news: TerminalHooklessNewsItem, facts: readonly TerminalSideEffectFact[]): void {
    for (const fact of facts) {
      if (fact.kind === 'agent-working') {
        this.noteWorking(news.paneKey)
      } else if (fact.kind === 'agent-idle' && !fact.staleWorkingTitleClear) {
        this.holdTitleFinish(news, fact.title)
      } else if (fact.kind === 'bell') {
        this.ringBell(news)
      }
    }
  }

  /** Work resumed, by title or hook: the finish is retracted and a bell it held rings. */
  noteWorking(paneKey: string): void {
    this.cancelFinish(paneKey)
    this.finishedAtByPane.delete(paneKey)
    const deferred = this.deferredBellByPane.get(paneKey)
    if (deferred) {
      this.scheduleBell(deferred)
    }
  }

  /** The pane closed or its agent left: nothing queued for it is news any more. */
  forget(paneKey: string): void {
    this.cancelFinish(paneKey)
    this.dropBell(paneKey)
    this.finishedAtByPane.delete(paneKey)
  }

  /** Any lane announced this pane's turn end; it absorbs the burst's bell. */
  noteFinish(paneKey: string): void {
    if (!this.deps.completionAlertsEnabled()) {
      return
    }
    for (const key of this.finishedAtByPane.keys()) {
      if (!this.finishedRecently(key)) {
        this.finishedAtByPane.delete(key)
      }
    }
    this.finishedAtByPane.set(paneKey, this.deps.now())
    this.dropBell(paneKey)
  }

  private holdTitleFinish(news: TerminalHooklessNewsItem, title: string): void {
    const { paneKey } = news
    this.cancelFinish(paneKey)
    // A hook pane's idle title echoes its hook state: the hook lane tells that turn, and its bell is absorbed.
    if (this.deps.hasHookRow(paneKey)) {
      this.noteFinish(paneKey)
      return
    }
    // As the window: a title finish with no hook detail goes out at the max wait.
    const timer = this.deps.setTimer(() => {
      this.pendingFinishByPane.delete(paneKey)
      // A late first hook row tells nothing unless the hook lane claimed this turn.
      if (!this.deps.hasPendingHookFinish(paneKey) && !this.finishedRecently(paneKey)) {
        this.noteFinish(paneKey)
        this.deps.deliverTitleFinish(news, title)
      }
      // A bell this finish held rings unless the finish it waited on alerted.
      const deferred = this.deferredBellByPane.get(paneKey)
      if (deferred) {
        this.scheduleBell(deferred)
      }
    }, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    this.pendingFinishByPane.set(paneKey, timer)
  }

  private cancelFinish(paneKey: string): void {
    this.pendingFinishByPane.get(paneKey)?.cancel()
    this.pendingFinishByPane.delete(paneKey)
  }

  private ringBell(news: TerminalHooklessNewsItem): void {
    if (this.finishedRecently(news.paneKey)) {
      return
    }
    this.deferredBellByPane.set(news.paneKey, news)
    if (!this.completionPending(news.paneKey)) {
      this.scheduleBell(news)
    }
  }

  // Wait so a same-burst completion wins, as the window's BEL does.
  private scheduleBell(news: TerminalHooklessNewsItem): void {
    const { paneKey } = news
    if (this.bellTimerByPane.has(paneKey)) {
      return
    }
    const timer = this.deps.setTimer(() => {
      this.bellTimerByPane.delete(paneKey)
      if (!this.completionPending(paneKey)) {
        this.deferredBellByPane.delete(paneKey)
        this.deps.deliverBell(news)
      }
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    this.bellTimerByPane.set(paneKey, timer)
  }

  private dropBell(paneKey: string): void {
    this.deferredBellByPane.delete(paneKey)
    this.bellTimerByPane.get(paneKey)?.cancel()
    this.bellTimerByPane.delete(paneKey)
  }

  private finishedRecently(paneKey: string): boolean {
    const finishedAt = this.finishedAtByPane.get(paneKey)
    return (
      finishedAt !== undefined &&
      this.deps.now() - finishedAt < AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
    )
  }

  private completionPending(paneKey: string): boolean {
    return (
      this.deps.completionAlertsEnabled() &&
      (this.pendingFinishByPane.has(paneKey) || this.deps.hasPendingHookFinish(paneKey))
    )
  }
}
