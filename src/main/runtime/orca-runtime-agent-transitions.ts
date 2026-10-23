import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
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
import {
  TerminalAgentPhonePush,
  type TerminalAgentWorkspaceLabels
} from './terminal-agent-phone-push'

/**
 * Owns the runtime's agent transition detector, and the phone push it drives while no window
 * runs here. Both run on every host and in every build.
 */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithMigrationCatalog {
  readonly agentTransitions = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    subscribeToPtyExit: (ptyId, listener) => this.subscribeToPtyExit(ptyId, listener),
    now: Date.now
  })
  private readonly terminalAgentPhonePush = new TerminalAgentPhonePush({
    // A desktop that has not shown its window yet counts as having one: that window seeds what it
    // missed rather than announcing it, so the phone hears no more than it does today.
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
    setTimer: (run, delayMs) => {
      // A pending finish must never hold the process open at quit.
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return { cancel: () => clearTimeout(timer) }
    },
    now: Date.now
  })

  private readonly externalConversations = installExternalConversations(this.store, this)

  /** The connector seam while `experimentalConnectors` is on; null refuses every connector call. */
  getExternalConversationSeam(): ExternalConversationSeam | null {
    return this.externalConversations.current()
  }

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithMigrationCatalog>) {
    super(...args)
    this.agentTransitions.subscribe((change) => this.terminalAgentPhonePush.observe(change))
  }

  /** Attaches the detector, and main's generated tab titles; layers above subscribe their readers first. */
  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    // Why here: each host attaches its hook store at startup, so an enabled connector seam watches
    // its links' agent sessions from then rather than from its first call.
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

  // The window's labels (getNotificationWorkspaceLabels), read from this host's own records.
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
    // The listing is a cache a catalog change empties; the persisted record names it meanwhile.
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
