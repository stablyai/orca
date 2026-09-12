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
    // The DERIVED pane key, never the orchestration bearer handle or the minted worker pane key:
    // both of those are credentials.
    const paneKey = structuredAgentSessionPaneKey(summary.sessionId)
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
   *  `dropStatusEntry`, not `clearPaneState`: the pane caches and authority fences a pane-status
   *  clear tears down belong to a PTY, and a structured session never had any. The renderer's copy
   *  is taken out by the surface teardown in `StructuredAgentSessionStatusBridge`, since this drop
   *  emits no renderer clear. */
  dropStructuredStatus(sessionId: string): void {
    this.dropStatusEntry(structuredAgentSessionPaneKey(sessionId), {
      preserveResumeIdentity: false
    })
  }
}
