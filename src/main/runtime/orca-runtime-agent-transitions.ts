import { watchMovedWorkerResumeSessions } from './rpc/methods/orchestration/worker/worker-resume-session-capture'
import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { installExternalConversations } from '../external-conversations/external-conversations-install'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { OrcaRuntimeWithWindowlessTerminalActivity } from './orca-runtime-windowless-terminal-activity'
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
import { ClaudeTerminalSessionNameSync } from './claude-terminal-session-name-sync'
import { readClaudeTranscriptCustomTitle } from '../claude/claude-terminal-session-name'
import { createLaunchedAgentWriteGuard } from './terminal/wait/launched-agent-write-guard'
import type { ExecutionHostId } from '../../shared/execution-host'
import { terminalIdOf, type WindowLayoutCommand } from './terminal/layout/runtime-layout-apply'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { RuntimeTerminalRename } from '../../shared/runtime-terminal-contracts'

// A draft or a long turn holds the rename; past this the user's newer intent is unknown.
const CLAUDE_RENAME_HOLD_MS = 10 * 60_000
const CLAUDE_RENAME_RECHECK_MS = 5_000

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

  private readonly claudeSessionNames = new ClaudeTerminalSessionNameSync({
    isEnabled: () => this.store?.getSettings().claudeSessionNameSync !== false,
    listRows: () => this.getAgentStatusSnapshotFn?.() ?? [],
    readTranscriptPath: (paneKey) => {
      let newest: { at: number; path: string } | null = null
      for (const row of this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []) {
        const path = row.agentType === 'claude' ? row.providerSession?.transcriptPath : undefined
        if (path && (!newest || row.receivedAt > newest.at)) {
          newest = { at: row.receivedAt, path }
        }
      }
      return newest?.path ?? null
    },
    getHandle: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    waitForEmptyComposer: (handle, signal) => this.waitForEmptyClaudeComposer(handle, signal),
    readComposerDraft: (handle) => this.readClaudeComposerDraft(handle),
    sendCommand: async (handle, text, signal, beforeEachWrite) => {
      // The pane may have returned to its shell since the hook row was written.
      const guard = createLaunchedAgentWriteGuard(this, 'claude')
      try {
        await this.sendTerminalAgentPrompt(handle, text, {
          inputKind: 'driving',
          beforeWrite: async (ptyId) => {
            await guard.beforeWrite(ptyId)
            await beforeEachWrite()
          },
          acceptQueued: true,
          observationTimeoutMs: 0,
          signal
        })
      } finally {
        guard.dispose()
      }
    },
    renameTab: async (handle, name) => {
      await this.renameTerminal(handle, name)
    },
    readCustomTitle: readClaudeTranscriptCustomTitle
  })

  /** A tab named in the window: its Claude pane takes the name as its session name. */
  syncClaudeSessionNameForTab(tabId: string, title: string | null): void {
    this.claudeSessionNames.tabRenamed(tabId, title)
  }

  /** The partitions holding a window layout command's tab, or its workspace's for a workspace command. */
  protected layoutHostIdsFor(worktreeId: string, tabId: string | null): ExecutionHostId[] {
    return tabId !== null
      ? this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)
      : [this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId) ?? []].flat()
  }

  /** A window rename main applied, in apply order, so a later rename always wins. */
  protected syncClaudeSessionNameAfterLayoutApply(
    command: WindowLayoutCommand,
    reply: LayoutApplyReply
  ): void {
    if (!reply.ok || command.type !== 'renameTab' || command.kind !== 'custom') {
      return
    }
    const hostId = this.layoutHostIdsFor(command.workspace, command.tabId)[0]
    const tabId = hostId
      ? terminalIdOf(this.requireStore(), hostId, command.workspace, command.tabId)
      : command.tabId
    this.claudeSessionNames.tabRenamed(tabId, command.title)
  }

  override async renameTerminal(
    handle: string,
    title: string | null
  ): Promise<RuntimeTerminalRename> {
    const rename = await super.renameTerminal(handle, title)
    if (rename.tabId) {
      this.claudeSessionNames.tabRenamed(rename.tabId, rename.title)
    }
    return rename
  }

  protected override observeClaudeTerminalTitle(paneKey: string, title: string): void {
    this.claudeSessionNames.observeTitle(paneKey, title)
  }

  /** Never type into a draft: it would be submitted with the command. */
  private async waitForEmptyClaudeComposer(handle: string, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + CLAUDE_RENAME_HOLD_MS
    while (!signal.aborted && Date.now() < deadline) {
      const wait = await this.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal
      })
      if (wait.satisfied && !(await this.readClaudeComposerDraft(handle))) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, CLAUDE_RENAME_RECHECK_MS).unref?.())
    }
    return false
  }

  private async readClaudeComposerDraft(handle: string): Promise<string | undefined> {
    return (await this.readTerminal(handle, { screen: true, limit: 1 })).draft
  }

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

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWindowlessTerminalActivity>) {
    super(...args)
    this.agentTransitions.subscribe((change) => this.terminalAgentPhonePush.observe(change))
    this.agentTransitions.subscribe((change) => this.terminalWorkerTurnStops.observe(change))
    this.agentTransitions.subscribe((change) => this.workerAutoReleaseActivity.observePane(change))
    this.agentTransitions.subscribe((change) => {
      if (change.kind === 'moved') {
        this.claudeSessionNames.observeTurnChange(change.paneKey)
      }
    })
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
    const detachCrew = store.subscribeStatusRowMutations(() =>
      this.crewChanges.notify(new Set(['status', 'names']))
    )
    this.crewChanges.notify(new Set(['status', 'names']))
    const subscribe = store.subscribeEnrichedStatus?.bind(store)
    const detachTitles = subscribe
      ? subscribeHookStatusTitles({ subscribeEnrichedStatus: subscribe }, this)
      : () => {}
    return () => {
      detachCrew()
      this.crewChanges.notify(new Set(['status', 'names']))
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
