import { crewStatusRowChange } from '../orchestration/crew/crew-changes'
import type { PairedDeviceAccountLookup } from '../rpc/server/pairing/device-entry'
import { worktreesUnderHomes } from '../../bots/bot-handed-workspaces'
import { forgetPairedReads } from '../../bots/bot-paired-handed-agents'
import type { SlackMirror } from '../../external-conversations/slack-mirror'
import type { AdmittedMessage } from '../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { botChatTakingMail } from '../rpc/methods/bots-chats'
import { watchMovedWorkerResumeSessions } from '../rpc/methods/orchestration/worker/follow-up/worker-resume-session-capture'
import { AgentTransitionDetector } from '../../agent-hooks/observations/agent-transition-detector'
import {
  followAgentPhasesForBots,
  followWorktreeLifecycleForBots
} from '../../bots/bot-change-notices'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'
import { botsCloudClient } from '../../connector-cloud/bots-cloud-client'
import type { ConnectorCloudFeature } from '../../../shared/connectors/connector-cloud-contract'
import { cloudTriggerPeopleSearch } from '../../automations/bot-trigger-people'
import type { ExternalConversationSeam } from '../../external-conversations/external-conversation-seam'
import { installExternalConversations } from '../../external-conversations/external-conversations-install'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { OrcaRuntimeWithWindowlessTerminalActivity } from '../sidebar-inputs/temporal/orca-runtime-windowless-terminal-activity'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { AgentStatusStoreView } from '../sidebar-inputs/workspace-facts/workspace-activity-facts-producer'
import { subscribeHookStatusRuntime } from '../orchestration/mailbox/terminal-pointer/hook-status-mail-wakeup'
import {
  resolveTerminalWorkerDispatch,
  TerminalWorkerTurnStops
} from '../orchestration/workers/turn-stops/terminal-worker-turn-stops'
import { TerminalWorkerApprovalHolds } from '../orchestration/workers/approvals/terminal-worker-approval-holds'
import { readClaudeToolRecord } from '../orchestration/workers/approvals/claude-tool-result-close'
import type { WorkerTerminalResourceRow } from '../orchestration/terminal-authority/release/worker-terminal-ownership'
import { resolveStructuredWorkerIdentity } from '../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import {
  chatStatusInTurn,
  terminalPhaseInTurn
} from '../orchestration/terminal-authority/release/worker-auto-release-activity'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import { WorktreeRowsChanges } from '../client/events/worktree-rows-change-events'
import {
  TerminalAgentPhonePush,
  type TerminalAgentWorkspaceLabels
} from '../push/notifications/terminal-agent-phone-push'

function unrefTimer(run: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** All hosts/builds own transition detection and windowless phone pushes. */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithWindowlessTerminalActivity {
  readonly agentTransitions = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    subscribeToPtyExit: (ptyId, listener) => this.subscribeToPtyExit(ptyId, listener),
    now: Date.now
  })
  private readonly terminalAgentPhonePush = new TerminalAgentPhonePush({
    // Pending desktop windows seed missed state without announcing it; do not duplicate their phone pushes.
    hasWindow: () =>
      this.authoritativeWindowId === null
        ? this.rendererGraphEpoch === 0
        : this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID,
    readNotificationSettings: () => this.store?.getSettings().notifications,
    readWorkspaceLabels: (worktreeId, paneKey) =>
      this.readTerminalAgentWorkspaceLabels(worktreeId, paneKey),
    isWorkspaceMuted: (worktreeId) => this.isWorkspaceNotificationMuted(worktreeId),
    readOrchestration: (paneKey) => this.getAgentStatusOrchestrationContextForPaneKey(paneKey),
    readTerminalTitle: (paneKey) => this.getPtyRecordForPaneKey(paneKey)?.lastOscTitle ?? null,
    readHookRow: (paneKey) => this.agentTransitions.latestRow(paneKey),
    translate: (key, fallback) =>
      getRuntimeDesktopSurface().translateNotification?.(key, fallback) ?? fallback,
    dispatch: (event) => this.mobileNotifications.dispatch(event),
    onClientEvent: (listener, options) => this.onClientEvent(listener, options),
    setTimer: unrefTimer,
    now: Date.now
  })
  private readonly terminalWorkerResolution = {
    getDb: () => this.workerTurnStopReportDeps.getDb(),
    getHandle: (paneKey: string) => this.getTerminalHandleForPaneKey(paneKey),
    getProcessIncarnation: (handle: string) => this.getTerminalProcessIncarnation(handle)
  }
  /** Claude terminal workers' waiting PermissionRequest hooks, answerable by their coordinator. */
  readonly terminalWorkerApprovals = new TerminalWorkerApprovalHolds({
    ...this.workerTurnStopReportDeps,
    resolveWorker: (paneKey) => {
      const resolved = resolveTerminalWorkerDispatch(this.terminalWorkerResolution, paneKey)
      // A remote attachment's coordinator answers at its Run home, which cannot reach this hook yet.
      return resolved?.target.kind === 'local'
        ? { db: resolved.db, handle: resolved.handle, dispatch: resolved.target.dispatch }
        : null
    },
    canAnswerPane: (paneKey) => {
      const pty = this.getPtyRecordForPaneKey(paneKey)
      // Windows hooks print `{}` before they post; WSL and SSH relays answer for Claude.
      return process.platform !== 'win32' && pty !== null && pty.connectionId === null && !pty.isWsl
    },
    processIncarnation: (handle) => this.getTerminalProcessIncarnation(handle),
    readToolRecord: (call) => readClaudeToolRecord(call.transcriptPath, call.toolUseId),
    readScreen: (paneKey) => {
      const ptyId = this.getPtyRecordForPaneKey(paneKey)?.ptyId
      return ptyId ? (this.readCaughtUpRuledScreen(ptyId)?.lines ?? null) : null
    },
    now: Date.now,
    setTimer: unrefTimer
  })
  // The execution host observes its own panes, so local, SSH and paired-server workers are all seen.
  protected readonly terminalWorkerTurnStops = new TerminalWorkerTurnStops({
    ...this.workerTurnStopReportDeps,
    ...this.terminalWorkerResolution,
    readHookRow: (paneKey) => this.agentTransitions.latestRow(paneKey),
    setTimer: unrefTimer,
    readScreen: (handle) => this.readTerminal(handle, { screen: true, limit: 15 }),
    takeOpenApproval: (paneKey, dispatchId) =>
      this.terminalWorkerApprovals.takeOpenApproval(paneKey, dispatchId),
    markApprovalReported: (approvalId) => this.terminalWorkerApprovals.markReported(approvalId)
  })

  private readonly externalConversations = installExternalConversations(this.store, this)

  // The sidebar feed's activity facts already announce row changes when it is on.
  private readonly worktreeRowsChanges = ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? null
    : new WorktreeRowsChanges((event) => this.emitClientEvent(event))

  protected onTitleAgentStatusChanged(): void {
    this.worktreeRowsChanges?.changed()
  }

  /** The connector seam; null (no store) refuses every connector call. */
  getExternalConversationSeam(): ExternalConversationSeam | null {
    return this.externalConversations.current()
  }

  /** A bot thread in this chat is no longer new: the owner opened the chat, or a run owns it. */
  markBotThreadSeen(sessionId: string): void {
    this.externalConversations.threadSeen(sessionId)
  }

  /** The bot whose home a worktree is, or whose home it sits under (its agents work for that bot). */
  private botOfWorkspace(worktreeId: string): string | null {
    const homes = new Map<string, string>(
      this.bots.list().map((bot) => [folderWorkspaceKey(bot.folderWorkspaceId), bot.id])
    )
    const home = homes.get(worktreeId)
    if (home) {
      return home
    }
    const handed = worktreesUnderHomes(this.store?.getAllWorkspaceLineage?.() ?? {}, [
      ...homes.keys()
    ])
    for (const [homeKey, ids] of handed) {
      if (ids.has(worktreeId)) {
        return homes.get(homeKey) ?? null
      }
    }
    return null
  }

  onChatMessageAdmitted(message: AdmittedMessage): void {
    this.externalConversations.current()?.messageAdmitted(message)
    this.externalConversations.slackMirror()?.admitted(message)
  }

  /** Posts the owner's Orca-typed messages to their bot chats' Slack threads; null without a store. */
  getSlackMirror(): SlackMirror | null {
    return this.externalConversations.slackMirror()
  }

  /** A bot's new thread shows in its Activity without waiting for an agent to start. */
  onConversationLinked(): void {
    this.botChangeNotices.changed({ kinds: ['threads'] })
  }

  private connectorCloud: ConnectorCloud | null = null

  declare protected readonly getPairedDeviceAccountFn: PairedDeviceAccountLookup

  /** The Orca account a paired device says it is signed in to; null when it named none. */
  readonly pairedDeviceAccount: PairedDeviceAccountLookup = (...args) =>
    this.getPairedDeviceAccountFn(...args)

  /** The desktop's link to the Orca Cloud connector; null in `orca serve` and in builds without cloud auth. */
  getConnectorCloud(): ConnectorCloud | null {
    return this.connectorCloud
  }

  setConnectorCloud(cloud: ConnectorCloud | null): void {
    this.connectorCloud = cloud
    this.automation.takesThreadReplies = () => cloud?.takesThreadReplies() ?? false
    this.automation.placeRefs = () => cloud?.refResolver() ?? null
    this.automation.triggerPeople = (bot) =>
      cloud?.cloudFeatures()?.has('triggers.people' satisfies ConnectorCloudFeature)
        ? cloudTriggerPeopleSearch(botsCloudClient(cloud), bot)
        : null
    this.automation.cloudTriggers = () => ({
      own: cloud?.cloudFeatures()?.has('triggers.own' satisfies ConnectorCloudFeature) ?? false,
      github2:
        cloud?.cloudFeatures()?.has('triggers.github2' satisfies ConnectorCloudFeature) ?? false,
      workflows:
        cloud?.cloudFeatures()?.has('triggers.workflows' satisfies ConnectorCloudFeature) ?? false
    })
  }

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWindowlessTerminalActivity>) {
    super(...args)
    this.servedOrcaProfileId = args[2]?.servedOrcaProfileId ?? null
    this.automation.botChat = (bot, id) => botChatTakingMail(this, bot, id)
    this.agentTransitions.subscribe((change) => this.terminalAgentPhonePush.observe(change))
    followAgentPhasesForBots(this.agentTransitions, this.botChangeNotices, {
      hasBots: () => this.bots.list().length > 0,
      botOfWorkspace: (worktreeId) => this.botOfWorkspace(worktreeId),
      botOfPane: (paneKey) => {
        const index = this.botChatTreeIndex
        const byPane = index?.botOfPane(paneKey)
        if (byPane) {
          return byPane
        }
        // A worker pane's Dispatch names its bot once the index has placed it.
        const dispatchId = this.getAgentStatusOrchestrationContextForPaneKey(paneKey)?.dispatchId
        return dispatchId ? (index?.botOfDispatch(dispatchId) ?? null) : null
      },
      inGroupRoom: (sessionId) => this.botSessions.groupRoomOf(sessionId) !== null,
      workerPane: (paneKey) =>
        this.getAgentStatusOrchestrationContextForPaneKey(paneKey) !== undefined,
      readEveryBot: () => this.botChatTreeIndex?.readEveryBot() !== false
    })
    // A paired computer that comes back is asked again at once, not after its unreachable backoff.
    this.orchestrationEnvironmentTransport?.onEnvironmentVerified?.((environmentId) =>
      forgetPairedReads(this, environmentId)
    )
    followWorktreeLifecycleForBots(
      (listener) => this.onWorktreeLifecycle(listener),
      this.botChangeNotices,
      (worktreeId) => {
        const index = this.botChatTreeIndex
        const find = () => this.botOfWorkspace(worktreeId) ?? index?.botOfWorktree(worktreeId)
        // A bot the index has not read yet may own it: read those once; every bot re-reads if one can't be.
        let botId = find()
        if (!botId && index) {
          if (!index.readEveryBot()) {
            return { kinds: ['workers'] }
          }
          botId = find()
        }
        return botId ? { botIds: [botId], kinds: ['workers'] } : null
      }
    )
    this.agentTransitions.subscribe((change) => this.terminalWorkerTurnStops.observe(change))
    this.agentTransitions.subscribe((change) => this.workerAutoReleaseActivity.observePane(change))
    const saveMovedWorkerSessions = watchMovedWorkerResumeSessions(
      this,
      () => this._orchestrationDb
    )
    this.subscribeAgentProviderSessionChangesFn?.((sessions) => {
      try {
        saveMovedWorkerSessions(sessions)
      } catch (error) {
        console.warn('[orchestration] a worker conversation change was not saved', error)
      }
    })
  }

  /** Whether a worker's agent is in a turn now, working or waiting on the user; an automatic close never takes one. */
  isWorkerAgentInTurn(
    resource: Pick<WorkerTerminalResourceRow, 'pane_key' | 'terminal_handle'>
  ): boolean {
    const structured = resolveStructuredWorkerIdentity(
      resource.terminal_handle,
      this._orchestrationDb
    )
    if (structured) {
      return chatStatusInTurn(
        getStructuredAgentSessionHost()?.readStatusSummary(structured.sessionId)?.status
      )
    }
    return (
      resource.pane_key !== null &&
      terminalPhaseInTurn(this.agentTransitions.phaseOf(resource.pane_key))
    )
  }

  /** Attach after higher layers subscribe; also drive generated tab titles. */
  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    // Attach connector watches at hook-store startup, before any connector call.
    this.externalConversations.current()
    const detachTransitions = this.agentTransitions.attach(store)
    // A row names its pane: a crew that shows neither pane reads nothing for it.
    const detachCrew = store.subscribeStatusRowMutations((mutation) =>
      this.crewChanges.notify(crewStatusRowChange(mutation))
    )
    this.crewChanges.notify(new Set(['status', 'names']))
    const detachRows = store.subscribeStatusRowMutations(() => this.worktreeRowsChanges?.changed())
    const subscribe = store.subscribeEnrichedStatus?.bind(store)
    const detachEnriched = subscribe
      ? subscribeHookStatusRuntime(subscribe, this, (row) => this.observeHookStatusForMail(row))
      : () => {}
    return () => {
      detachCrew()
      detachRows()
      this.crewChanges.notify(new Set(['status', 'names']))
      detachEnriched()
      detachTransitions()
    }
  }

  private readTerminalAgentWorkspaceLabels(
    worktreeId: string,
    paneKey: string
  ): TerminalAgentWorkspaceLabels {
    const store = this.store
    const tabId = parsePaneKey(paneKey)?.tabId
    const fallback =
      (tabId ? this.tabs.get(tabId)?.title?.trim() : undefined) ||
      this.agentTransitions.latestRow(paneKey)?.agentType ||
      'workspace'
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const folder = store?.getFolderWorkspaces?.().find((f) => f.id === scope.folderWorkspaceId)
      const group = folder
        ? store?.getProjectGroups?.().find((item) => item.id === folder.projectGroupId)
        : undefined
      return { repoLabel: group?.name, worktreeLabel: folder?.name || fallback }
    }
    const id = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
    // Catalog changes empty the listing cache; persisted metadata remains available.
    const listed = this.resolvedWorktrees.peek()?.worktrees.find((item) => item.id === id)
    const meta = listed ? undefined : store?.getWorktreeMeta(id)
    const repoId = listed?.repoId ?? (meta ? getRepoIdFromWorktreeId(id) : undefined)
    const repo = repoId ? store?.getRepo(repoId) : undefined
    return {
      repoLabel: repo?.displayName,
      worktreeLabel: listed?.displayName || listed?.branch || meta?.displayName || fallback
    }
  }
}
