import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'

export abstract class OrcaRuntimeWithStructuredSessionWorkspacePresentation extends OrcaRuntimeWithStructuredSessionTabProjection {
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[],
    eligible?: (change: ChatTabChange) => boolean
  ): Promise<void>

  async reconcileStructuredSessionWorkspacePresentation(
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    const host = getStructuredAgentSessionHost()
    const record = host?.deps.store.getConversation(sessionId)
    if (!record || record.location.workspaceId !== workspaceId) {
      return
    }
    const saved = this.store?.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {}
    const workspaces = new Set([...Object.keys(saved), ...this.mobileSessionTabsByWorktree.keys()])
    const registered = new Set(
      (this.store?.getRepos() ?? [])
        .filter((repo) => getRepoExecutionHostId(repo) === record.location.executionHostId)
        .map((repo) => repo.id)
    )
    for (const oldId of workspaces) {
      const retired = splitWorktreeIdForFilesystem(oldId)
      if (oldId === workspaceId || !retired || registered.has(retired.repoId)) {
        continue
      }
      const eligible = () =>
        getStructuredAgentSessionHost() === host &&
        host?.deps.store.getConversation(sessionId)?.location.workspaceId === workspaceId
      const tab = saved[oldId]?.find(
        (candidate) =>
          savedSessionId(candidate) === sessionId &&
          (!candidate.executionHostId ||
            candidate.executionHostId === record.location.executionHostId)
      )
      if (tab) {
        await this.changeWindowlessChatTabs(oldId, [{ close: sessionId, tabId: tab.id }], eligible)
      }
      const raw = this.mobileSessionTabsByWorktree
        .get(oldId)
        ?.tabs.find(
          (candidate) => candidate.type === 'agent-session' && candidate.sessionId === sessionId
        )
      if (raw && eligible()) {
        this.retireStructuredAgentSessionTabFromSnapshot(sessionId, raw.id, oldId)
      }
    }
  }
}
