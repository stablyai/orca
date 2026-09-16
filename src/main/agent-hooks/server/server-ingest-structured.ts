import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { AgentHookServerIngestTerminal } from './server-ingest-terminal'

/**
 * Structured (native chat) sessions have no PTY and no hook script, so nothing else reaches this
 * store for them. The host projects each session's journal into a summary; this is where that
 * summary becomes the same row every other agent has, keyed by the pane key the renderer derives.
 */
export abstract class AgentHookServerIngestStructured extends AgentHookServerIngestTerminal {
  ingestStructuredStatus(summary: AgentSessionStatusSummary): void {
    const paneKey = structuredStatusPaneKey(summary.sessionId)
    // No persisted turn yet: the chat shows nothing, so neither does any status reader.
    if (!summary.status) {
      this.dropStructuredStatus(summary.sessionId)
      return
    }
    if (this.getAgentStatusDisposition(paneKey) !== 'accept') {
      return
    }
    const payload: ParsedAgentStatusPayload = {
      state: structuredAgentSessionStatusState(summary.status),
      prompt: summary.latestPrompt,
      agentType: summary.agent,
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.toolName ? { toolName: summary.toolName } : {}),
      ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
      ...(summary.lastAssistantMessage
        ? { lastAssistantMessage: summary.lastAssistantMessage }
        : {})
    }
    // The journal clock stamps the evidence so a restart's republish does not read as fresh work.
    this.applyNormalizedStatus(
      {
        paneKey,
        tabId: structuredAgentSessionTabId(summary.sessionId),
        worktreeId: summary.workspaceId,
        connectionId: null,
        structuredHost: summary.hostExecutionOwned ? 'owned' : 'held',
        ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
        payload
      },
      undefined,
      'structured',
      summary.updatedAt
    )
  }

  /** The host no longer holds the session; its last projection is history the journal keeps.
   *  `dropStatusEntry`, not `clearPaneState`: the renderer's own bridge still owns this pane key,
   *  so a pane-status-clear would make main a second writer for it. */
  dropStructuredStatus(sessionId: string): void {
    this.dropStatusEntry(structuredStatusPaneKey(sessionId), { preserveResumeIdentity: false })
  }
}

// The DERIVED pane key the renderer publishes, never the orchestration bearer handle or the minted
// worker pane key: both of those are credentials.
function structuredStatusPaneKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}
