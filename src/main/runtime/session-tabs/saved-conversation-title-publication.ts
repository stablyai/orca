import { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from './session-tabs-change-publication'
import { StructuredConversationLabelChanges } from './structured-conversation-label-changes'
import { retitleStructuredConversationTabs } from './structured-conversation-tab-title'
import { savedWorkspaceCatalog } from '../../persistence/profile-save-domains'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { structuredChatDisplayName } from '../../../shared/structured-chat-row-name'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'

export abstract class OrcaRuntimeWithSavedConversationTitlePublication extends OrcaRuntimeWithScheduleMobileSessionTabsChanged {
  private labelChangesTracker?: StructuredConversationLabelChanges
  private titleRoutesDirty = false
  private titleWorktrees?: WeakRef<object>
  private titleNameStore = getStructuredAgentSessionHost()?.deps?.store ?? null

  private get labelChanges(): StructuredConversationLabelChanges {
    return (this.labelChangesTracker ??= new StructuredConversationLabelChanges(
      this.store,
      (workspaceId) => this.tryGetWorkspaceSessionHostIdForWorktree(workspaceId)
    ))
  }

  constructor(
    ...args: ConstructorParameters<typeof OrcaRuntimeWithScheduleMobileSessionTabsChanged>
  ) {
    super(...args)
    const worktrees = ORCA_LAYOUT_OWNER_IS_MAIN ? this.resolvedWorktrees.peek()?.worktrees : null
    if (worktrees) {
      this.titleWorktrees = new WeakRef(worktrees)
    }
    this.store?.onStateWritten?.((domains) => {
      if (savedWorkspaceCatalog(domains)) {
        this.titleRoutesDirty = true
      }
    })
    // Desktop chat renames reach main through saved window sessions only.
    this.store?.onWorkspaceSessionWritten?.((hostId) => this.refreshSavedConversationTitles(hostId))
  }

  override storeMobileSessionSnapshot(
    workspaceId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const stored = super.storeMobileSessionSnapshot(workspaceId, snapshot)
    if (stored.tabs.some((tab) => tab.type === 'agent-session')) {
      this.labelChanges.seed(workspaceId)
    } else {
      this.labelChanges.forget(workspaceId)
    }
    return stored
  }

  protected override notifyMobileSessionTabsRemoved(workspaceId: string): void {
    this.labelChanges.forget(workspaceId)
    super.notifyMobileSessionTabsRemoved(workspaceId)
  }

  private refreshSavedConversationTitles(hostId: ExecutionHostId | null): void {
    const nameStore = getStructuredAgentSessionHost()?.deps?.store ?? null
    const sourceChanged = nameStore !== this.titleNameStore
    this.titleNameStore = nameStore
    const worktrees = ORCA_LAYOUT_OWNER_IS_MAIN ? this.resolvedWorktrees.peek()?.worktrees : null
    const routesDirty =
      this.titleRoutesDirty || (this.titleWorktrees?.deref() ?? null) !== (worktrees ?? null)
    this.titleRoutesDirty = false
    this.titleWorktrees = worktrees ? new WeakRef(worktrees) : undefined
    const changes = this.labelChanges.reconcile(hostId, routesDirty)
    if (sourceChanged) {
      for (const [workspaceId, snapshot] of this.mobileSessionTabsByWorktree) {
        const aliases = this.labelChanges.aliasesFor(workspaceId)
        const changed = changes.get(workspaceId) ?? new Map<string, string | null>()
        for (const tab of snapshot.tabs) {
          if (tab.type === 'agent-session') {
            changed.set(tab.sessionId, aliases?.get(tab.sessionId) ?? null)
          }
        }
        if (changed.size > 0) {
          changes.set(workspaceId, changed)
        }
      }
    }
    const publications: string[] = []
    for (const [workspaceId, aliases] of changes) {
      const snapshot = this.mobileSessionTabsByWorktree.get(workspaceId)
      if (!snapshot) {
        continue
      }
      const names = new Map<string, string | null>()
      for (const [sessionId, alias] of aliases) {
        const record = nameStore?.getConversation(sessionId)
        const name = record?.location.workspaceId === workspaceId ? record.conversationName : null
        names.set(sessionId, structuredChatDisplayName(alias, name, '') || null)
      }
      const next = retitleStructuredConversationTabs(snapshot, names)
      if (next) {
        this.storeMobileSessionSnapshot(workspaceId, next)
        publications.push(workspaceId)
      }
    }
    // Commit all title inputs before synchronous subscribers can write another session.
    for (const workspaceId of publications) {
      const snapshot = this.mobileSessionTabsByWorktree.get(workspaceId)
      if (snapshot) {
        this.emitMobileSessionTabsSnapshot(snapshot)
      }
    }
  }
}
