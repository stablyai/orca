import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { installExternalConversations } from '../external-conversations/external-conversations-install'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { AgentStatusStoreView } from './sidebar-inputs/workspace-activity-facts-producer'
import { subscribeHookStatusTitles } from './terminal/layout/hook-status-title-subscription'
import { TerminalWorkerTurnStops } from './orchestration/terminal-worker-turn-stops'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import { resolveStructuredWorkerIdentity } from './structured-worker-authority'
import { chatStatusInTurn, terminalPhaseInTurn } from './orchestration/worker-auto-release-activity'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  TerminalAgentPhonePush,
  type TerminalAgentWorkspaceLabels
} from './terminal-agent-phone-push'

function unrefTimer(run: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** All hosts/builds own transition detection and windowless phone pushes. */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithMigrationCatalog {
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
    readHookRow: (paneKey) => this.agentTransitions.latestRow(paneKey),
    translate: (key, fallback) =>
      getRuntimeDesktopSurface().translateNotification?.(key, fallback) ?? fallback,
    dispatch: (event) => this.mobileNotifications.dispatch(event),
    setTimer: unrefTimer,
    now: Date.now
  })
  // The execution host observes its own panes, so local, SSH and paired-server workers are all seen.
  private readonly terminalWorkerTurnStops = new TerminalWorkerTurnStops({
    ...this.workerTurnStopReportDeps,
    readHookRow: (paneKey) => this.agentTransitions.latestRow(paneKey),
    setTimer: unrefTimer,
    getHandle: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    getProcessIncarnation: (handle) => this.getTerminalProcessIncarnation(handle),
    readScreen: (handle) => this.readTerminal(handle, { screen: true, limit: 15 })
  })

  private readonly externalConversations = installExternalConversations(this.store, this)

  /** The connector seam while `experimentalConnectors` is on; null refuses every connector call. */
  getExternalConversationSeam(): ExternalConversationSeam | null {
    return this.externalConversations.current()
  }

  private connectorCloud: ConnectorCloud | null = null

  /** The desktop's link to the Orca Cloud connector; null in `orca serve` and in builds without cloud auth. */
  getConnectorCloud(): ConnectorCloud | null {
    return this.connectorCloud
  }

  setConnectorCloud(cloud: ConnectorCloud | null): void {
    this.connectorCloud = cloud
  }

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithMigrationCatalog>) {
    super(...args)
    this.agentTransitions.subscribe((change) => this.terminalAgentPhonePush.observe(change))
    this.agentTransitions.subscribe((change) => this.terminalWorkerTurnStops.observe(change))
    this.agentTransitions.subscribe((change) => this.workerAutoReleaseActivity.observePane(change))
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
    const subscribe = store.subscribeEnrichedStatus?.bind(store)
    const detachTitles = subscribe
      ? subscribeHookStatusTitles({ subscribeEnrichedStatus: subscribe }, this)
      : () => {}
    return () => {
      detachTitles()
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
