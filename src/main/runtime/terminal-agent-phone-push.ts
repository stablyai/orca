// The execution host's own phone push for hook-reported terminal agents, while no desktop window
// runs on it: a turn that finished (or failed) and an agent that needs input.
//
// WHY ONLY WITHOUT A WINDOW: a window runs its own detection and pushes this host's phones through
// main, as it always has. A host with no window (`orca serve`, `orcad`, a desktop whose window is
// closed) had nobody to make the call, so the phones heard nothing. Here the host makes it with the
// window's own rules, timing and wording; while a window owns the host, it stays silent.
//
// The phone suppresses an alert for what it is showing itself, so the host never guesses who looks.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { isPiCompatibleAgentType } from '../../shared/pi-agent-kind'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'

export type TerminalAgentWorkspaceLabels = { repoLabel?: string; worktreeLabel?: string }

type PaneNews = {
  worktreeId: string
  event: MobileNotificationDispatchEvent
  /** Waiting out a finish's quiet window. */
  quiet: { cancel: () => void } | null
}

export type TerminalAgentPhonePushDeps = {
  /** A desktop window owns this host and pushes its phones itself. */
  hasWindow: () => boolean
  readNotificationSettings: () => NotificationSettings | undefined
  /** In-memory only, as the window's: the alert must not wait on a lookup. */
  readWorkspaceLabels: (worktreeId: string, paneKey: string) => TerminalAgentWorkspaceLabels
  isWorkspaceMuted: (worktreeId: string) => boolean
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  translate?: (key: string, fallback: string) => string
  dispatch: (event: MobileNotificationDispatchEvent) => void
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
}

export class TerminalAgentPhonePush {
  // A pane's pending finish, until it is sent or the pane moves on.
  private readonly newsByPane = new Map<string, PaneNews>()
  // The burst gate the window's fan-out applies, per workspace.
  private readonly recentDispatches = new Map<string, number>()
  // Per pane, the `turnCompletedAt` of the turn last announced (or restored), until the next turn.
  private readonly finishedTurnByPane = new Map<string, number>()
  // Panes that reported live work since their last finish: as the window's, only those wait out
  // the quiet window.
  private readonly workingSeen = new Set<string>()

  constructor(private readonly deps: TerminalAgentPhonePushDeps) {}

  observe(change: AgentPaneChange): void {
    const { paneKey } = change
    if (change.kind === 'seeded') {
      if (change.phase !== 'rest') {
        this.seed(paneKey)
      }
      return
    }
    if (change.kind === 'observed') {
      if (change.phase === 'working') {
        this.observeWorking(paneKey, change.workspace?.worktreeId)
      }
      return
    }
    const { transition } = change
    const finished = transition === 'turn-finished' || transition === 'errored'
    const row = finished || transition === 'needs-input' ? this.deps.readHookRow(paneKey) : null
    // The all-clear of a turn announced when its lead agent finished: that finish still stands.
    if (
      finished &&
      row?.turnCompletedAt !== undefined &&
      this.finishedTurnByPane.get(paneKey) === row.turnCompletedAt
    ) {
      return
    }
    this.cancelPending(paneKey)
    if (transition === 'prompt-submitted' || change.to === 'rest') {
      this.finishedTurnByPane.delete(paneKey)
    }
    if (change.to === 'rest') {
      this.workingSeen.delete(paneKey)
    }
    if (!row) {
      return
    }
    if (transition === 'needs-input') {
      this.announce(paneKey, change.workspace.worktreeId, row, false)
      return
    }
    // Goal and Pi agents report a milestone done mid-run; work resuming within the window cancels it.
    const waitOutQuiet = this.workingSeen.has(paneKey) || isPiCompatibleAgentType(row.agentType)
    this.workingSeen.delete(paneKey)
    this.announce(paneKey, change.workspace.worktreeId, row, waitOutQuiet)
  }

  private observeWorking(paneKey: string, worktreeId: string | undefined): void {
    const row = this.deps.readHookRow(paneKey)
    if (!row || row.state !== 'working' || !worktreeId) {
      return
    }
    const { turnCompletedAt } = row
    if (turnCompletedAt === undefined) {
      this.workingSeen.add(paneKey)
      return
    }
    // The lead agent finished while background work keeps the pane working: as the window does,
    // that is the turn's finish, named by its `turnCompletedAt` and announced at once, once.
    if (this.finishedTurnByPane.get(paneKey) === turnCompletedAt) {
      return
    }
    this.finishedTurnByPane.set(paneKey, turnCompletedAt)
    // A finish of work this host never saw is the window's to drop too; it still marks the turn told.
    if (!this.workingSeen.has(paneKey)) {
      return
    }
    this.workingSeen.delete(paneKey)
    this.cancelPending(paneKey)
    const finish = { ...row, state: 'done' as const, stateStartedAt: turnCompletedAt }
    this.announce(paneKey, worktreeId, finish, false)
  }

  // As the window seeds a restored pane: a working one counts as work seen, a stamped turn as told.
  private seed(paneKey: string): void {
    const row = this.deps.readHookRow(paneKey)
    if (row?.turnCompletedAt !== undefined) {
      this.finishedTurnByPane.set(paneKey, row.turnCompletedAt)
    }
    if (row?.state === 'working') {
      this.workingSeen.add(paneKey)
    }
  }

  private announce(
    paneKey: string,
    worktreeId: string,
    row: AgentStatusIpcPayload,
    waitOutQuiet: boolean
  ): void {
    // A structured chat's projected row is pushed by the structured lane.
    if (row.structuredHost) {
      return
    }
    const news: PaneNews = {
      worktreeId,
      event: this.buildEvent(worktreeId, paneKey, row),
      quiet: null
    }
    if (!waitOutQuiet) {
      this.send(news)
      return
    }
    this.newsByPane.set(paneKey, news)
    news.quiet = this.deps.setTimer(() => {
      this.newsByPane.delete(paneKey)
      this.send(news)
    }, AGENT_DONE_QUIET_MS)
  }

  private cancelPending(paneKey: string): void {
    this.newsByPane.get(paneKey)?.quiet?.cancel()
    this.newsByPane.delete(paneKey)
  }

  private buildEvent(
    worktreeId: string,
    paneKey: string,
    row: AgentStatusIpcPayload
  ): MobileNotificationDispatchEvent {
    const outcome = agentMainAgentVerdict(row)
    const request: NotificationDispatchRequest = {
      source: 'agent-task-complete',
      worktreeId,
      paneKey,
      ...this.readLabels(worktreeId, paneKey),
      agentState: row.state,
      ...(row.agentType ? { agentType: row.agentType } : {}),
      ...(row.prompt ? { agentPrompt: row.prompt } : {}),
      ...(row.toolName ? { agentToolName: row.toolName } : {}),
      ...(row.toolInput ? { agentToolInput: row.toolInput } : {}),
      ...(row.lastAssistantMessage ? { agentLastAssistantMessage: row.lastAssistantMessage } : {}),
      ...(outcome ? { agentTurnOutcome: outcome } : {})
    }
    const { title, body } = buildNotificationOptions(request, this.deps.translate)
    const notificationId = buildAgentNotificationId({
      worktreeId,
      paneKey,
      stateStartedAt: row.stateStartedAt
    })
    return {
      type: 'notification',
      source: 'agent-task-complete',
      title,
      body,
      worktreeId,
      ...(notificationId ? { notificationId } : {}),
      agentState: row.state
    }
  }

  private send(news: PaneNews): void {
    // Decided when the alert would go out: a window that took over by then announces it itself.
    if (this.deps.hasWindow() || this.deps.isWorkspaceMuted(news.worktreeId)) {
      return
    }
    const settings = this.deps.readNotificationSettings()
    // The window's own fan-out gates the phone on these same preferences.
    const desktopAllowed = settings?.enabled !== false && settings?.agentTaskComplete !== false
    const now = this.deps.now()
    const burstKey = JSON.stringify([desktopAllowed, news.event.agentState, news.worktreeId])
    if (!reserveNotificationCooldown(this.recentDispatches, burstKey, now)) {
      return
    }
    // No attention key: later cooldowns then key on the workspace, as the window's request does.
    this.deps.dispatch({
      ...news.event,
      emittedAt: now,
      ...(!desktopAllowed ? { desktopAllowed: false } : {})
    })
  }

  private readLabels(worktreeId: string, paneKey: string): TerminalAgentWorkspaceLabels {
    try {
      return this.deps.readWorkspaceLabels(worktreeId, paneKey)
    } catch {
      // A label is presentation: without one the alert still goes out, worded generically.
      return {}
    }
  }
}
