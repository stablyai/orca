// Push agent finish/input alerts and bells from windowless execution hosts using desktop rules. A window already pushes these phones; the phone suppresses its own visible chat.
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  agentPaneWorkspace,
  type AgentPaneChange
} from '../../../agent-hooks/observations/agent-transition-detector'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal/output/terminal-side-effect-facts'
import { agentMainAgentVerdict } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../../../shared/agent-status/presentation/agent-notification-id'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  isCoordinatorOnlyNews,
  withApprovalTitle
} from '../../../../shared/orchestration/workers/dispatched-worker-attention'
import { reserveNotificationCooldown } from '../../../../shared/notifications/notification-burst-cooldown'
import { isNotificationSourceEnabled } from '../../../../shared/notifications/notification-source-gate'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../../../shared/notifications/notification-settings-types'
import { buildNotificationOptions } from '../../../ipc/notifications/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import { TerminalAgentTurnNews } from './terminal-agent-turn-news'
import type { RuntimeClientEventBus } from '../../client/events/runtime-client-event-bus'
import { TerminalHooklessNews, type TerminalHooklessNewsItem } from './terminal-hookless-news'

export type TerminalAgentWorkspaceLabels = { repoLabel?: string; worktreeLabel?: string }

type PaneNews = {
  worktreeId: string
  event: MobileNotificationDispatchEvent
}

type TurnNews = PaneNews & {
  paneKey: string
  row: AgentStatusIpcPayload
  labels: TerminalAgentWorkspaceLabels
}

export type TerminalAgentPhonePushDeps = {
  /** A desktop window owns this host and pushes its phones itself. */
  hasWindow: () => boolean
  readNotificationSettings: () => NotificationSettings | undefined
  /** In-memory only, as the window's: the alert must not wait on a lookup. */
  readWorkspaceLabels: (worktreeId: string, paneKey: string) => TerminalAgentWorkspaceLabels
  isWorkspaceMuted: (worktreeId: string) => boolean
  readOrchestration: (paneKey: string) => AgentStatusOrchestrationContext | undefined
  readTerminalTitle: (paneKey: string) => string | null
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  translate?: (key: string, fallback: string) => string
  dispatch: (event: MobileNotificationDispatchEvent) => void
  /** Title edges and bells reach a window as facts; without one, this lane tells the phones. */
  onClientEvent: RuntimeClientEventBus['on']
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
}

export class TerminalAgentPhonePush {
  // The burst gate the window's fan-out applies, per workspace.
  private readonly recentDispatches = new Map<string, number>()
  private readonly turnNews: TerminalAgentTurnNews<TurnNews>
  private readonly hooklessNews: TerminalHooklessNews

  constructor(private readonly deps: TerminalAgentPhonePushDeps) {
    this.turnNews = new TerminalAgentTurnNews({
      readHookRow: (paneKey) => deps.readHookRow(paneKey),
      prepare: ({ paneKey, worktreeId, row }) => {
        const labels = this.readLabels(worktreeId, paneKey)
        return {
          worktreeId,
          paneKey,
          row,
          labels,
          event: this.buildEvent(worktreeId, paneKey, row, labels)
        }
      },
      deliver: (news, row) => {
        if (news.event.paneKey) {
          this.hooklessNews.noteFinish(news.event.paneKey)
        }
        // The turn's reply can arrive after the finish was decided; rebuilt only for a phone that gets it.
        const replied = row.lastAssistantMessage !== news.row.lastAssistantMessage
        this.send(news, () =>
          replied
            ? { ...news, event: this.buildEvent(news.worktreeId, news.paneKey, row, news.labels) }
            : news
        )
      },
      setTimer: (run, delayMs) => deps.setTimer(run, delayMs)
    })
    this.hooklessNews = new TerminalHooklessNews({
      hasHookRow: (paneKey) => deps.readHookRow(paneKey) !== null,
      hasPendingHookFinish: (paneKey) => this.turnNews.hasPending(paneKey),
      completionAlertsEnabled: () => {
        const settings = deps.readNotificationSettings()
        return !settings || isNotificationSourceEnabled(settings, 'agent-task-complete', undefined)
      },
      deliverTitleFinish: (news, title) =>
        this.send(this.buildHooklessNews('agent-task-complete', news, title)),
      deliverBell: (news) => this.send(this.buildHooklessNews('terminal-bell', news)),
      setTimer: (run, delayMs) => deps.setTimer(run, delayMs),
      now: () => deps.now()
    })
    deps.onClientEvent(
      (event) => {
        if (event.type === 'terminalSideEffects') {
          this.noteTerminalSideEffects(event.batch)
        }
      },
      { consumesTerminalSideEffects: true }
    )
  }

  observe(change: AgentPaneChange): void {
    this.turnNews.observe(change)
    if (change.kind === 'moved' && change.to === 'working') {
      this.hooklessNews.noteWorking(change.paneKey)
    }
  }

  private noteTerminalSideEffects(batch: TerminalSideEffectBatch): void {
    const { worktreeId, paneKey } = batch
    // Replays restore titles only; their edges and bells were told live.
    if (batch.replay || !worktreeId || !paneKey) {
      return
    }
    const { sshHostId } = agentPaneWorkspace(worktreeId, batch.connectionId)
    this.hooklessNews.noteFacts({ paneKey, worktreeId, executionHostId: sshHostId }, batch.facts)
  }

  /** A bell or a title-only finish: no hook row, so no agent detail, as the window sends it. */
  private buildHooklessNews(
    source: 'agent-task-complete' | 'terminal-bell',
    { paneKey, worktreeId, executionHostId }: TerminalHooklessNewsItem,
    terminalTitle?: string
  ): PaneNews {
    const { title, body } = buildNotificationOptions(
      {
        source,
        worktreeId,
        paneKey,
        ...this.readLabels(worktreeId, paneKey),
        ...(terminalTitle ? { terminalTitle } : {})
      },
      this.deps.translate
    )
    return {
      worktreeId,
      event: {
        type: 'notification',
        ...(executionHostId ? { workspaceExecutionHostId: executionHostId } : {}),
        source,
        title,
        body,
        worktreeId,
        paneKey
      }
    }
  }

  private buildEvent(
    worktreeId: string,
    paneKey: string,
    row: AgentStatusIpcPayload,
    labels: TerminalAgentWorkspaceLabels
  ): MobileNotificationDispatchEvent {
    const outcome = agentMainAgentVerdict(row)
    const request: NotificationDispatchRequest = {
      source: 'agent-task-complete',
      worktreeId,
      paneKey,
      ...labels,
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
      ...(row.connectionId
        ? { workspaceExecutionHostId: getConnectionExecutionHostId(row.connectionId) }
        : {}),
      source: 'agent-task-complete',
      title,
      body,
      worktreeId,
      paneKey,
      ...(notificationId ? { notificationId } : {}),
      agentState: row.state
    }
  }

  private send(decided: PaneNews, current: () => PaneNews = () => decided): void {
    // Recheck window ownership at delivery to avoid duplicating a newly opened window's push.
    const { agentState, paneKey } = decided.event
    if (
      this.deps.hasWindow() ||
      this.deps.isWorkspaceMuted(decided.worktreeId) ||
      (paneKey &&
        isCoordinatorOnlyNews(
          withApprovalTitle(agentState, this.deps.readTerminalTitle(paneKey)),
          () => this.deps.readOrchestration(paneKey)
        ))
    ) {
      return
    }
    const settings = this.deps.readNotificationSettings()
    const { source } = decided.event
    // The window's own fan-out gates the phone on these same preferences.
    const desktopAllowed = !settings || isNotificationSourceEnabled(settings, source, agentState)
    const now = this.deps.now()
    const burstKey = JSON.stringify([desktopAllowed, source, agentState, decided.worktreeId])
    if (!reserveNotificationCooldown(this.recentDispatches, burstKey, now)) {
      return
    }
    // Only the alert that goes out is rebuilt; a refresh keeps its source, state and workspace.
    const news = current()
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
