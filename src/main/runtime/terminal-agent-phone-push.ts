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
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import { TerminalAgentTurnNews } from './terminal-agent-turn-news'

export type TerminalAgentWorkspaceLabels = { repoLabel?: string; worktreeLabel?: string }

type PaneNews = {
  worktreeId: string
  event: MobileNotificationDispatchEvent
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
  // The burst gate the window's fan-out applies, per workspace.
  private readonly recentDispatches = new Map<string, number>()
  private readonly turnNews: TerminalAgentTurnNews<PaneNews>

  constructor(private readonly deps: TerminalAgentPhonePushDeps) {
    this.turnNews = new TerminalAgentTurnNews({
      readHookRow: (paneKey) => deps.readHookRow(paneKey),
      prepare: ({ paneKey, worktreeId, row }) => ({
        worktreeId,
        event: this.buildEvent(worktreeId, paneKey, row)
      }),
      deliver: (news) => this.send(news),
      setTimer: (run, delayMs) => deps.setTimer(run, delayMs)
    })
  }

  observe(change: AgentPaneChange): void {
    this.turnNews.observe(change)
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
