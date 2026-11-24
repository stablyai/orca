import { OrcaRuntimeWithAgentQuestions } from '../../construction/orca-runtime-agent-questions'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { sessionTabPaneKey } from '../../../../shared/remote-runtime/session-graph/session-tab-pane-key'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export abstract class RuntimeAgentOverviewProjection extends OrcaRuntimeWithAgentQuestions {
  projectLocalAgentSessionTabs(frame: RuntimeMobileSessionTabsResult): {
    frame: RuntimeMobileSessionTabsResult
    complete: boolean
  } {
    let complete = true
    const tabs = frame.tabs.filter((tab) => {
      if (tab.type === 'agent-session') {
        try {
          const record = getStructuredAgentSessionHost()?.deps.store.getConversation(tab.sessionId)
          if (!record) {
            complete = false
            return false
          }
          return (
            record.location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
            worktreeIdsEqual(record.location.workspaceId, frame.worktree)
          )
        } catch {
          complete = false
          return false
        }
      }
      if (tab.type !== 'terminal') {
        return false
      }
      if (tab.agentStatus?.executionHost === 'shared') {
        complete = false
        return false
      }
      const paneKey = sessionTabPaneKey(tab)
      const pty = paneKey ? this.getPtyRecordForPaneKey(paneKey) : null
      if (pty) {
        return (
          pty.connectionId === null &&
          pty.isWsl !== true &&
          (pty.worktreeInferredFromCwd === true || worktreeIdsEqual(pty.worktreeId, frame.worktree))
        )
      }
      const owners = this.getWorkspaceSessionHostIdsForTab(frame.worktree, tab.parentTabId, {
        requireExactTab: true
      })
      if (owners.length === 0 && (tab.agentStatus || tab.launchAttested)) {
        complete = false
      }
      return (
        owners.includes(LOCAL_EXECUTION_HOST_ID) &&
        !tab.agentStatus?.connectionId &&
        tab.agentStatus?.executionHost !== 'shared'
      )
    })
    return { frame: { ...frame, tabs }, complete }
  }
}
