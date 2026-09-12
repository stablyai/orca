import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  makeStructuredAgentStatusSubject,
  parseAgentStatusSubject,
  type AgentStatusSubject
} from '../../../shared/agent-status-subject'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
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
  ingestStructuredStatus(summary: AgentSessionStatusSummary): void
  ingestStructuredStatus(subject: AgentStatusSubject, summary: AgentSessionStatusSummary): void
  ingestStructuredStatus(
    subjectOrSummary: AgentStatusSubject | AgentSessionStatusSummary,
    maybeSummary?: AgentSessionStatusSummary
  ): void {
    const summary = maybeSummary ?? (subjectOrSummary as AgentSessionStatusSummary)
    const parsedSubject = maybeSummary ? parseAgentStatusSubject(subjectOrSummary) : null
    if (
      maybeSummary &&
      (parsedSubject?.kind !== 'structured-session' ||
        parsedSubject.sessionId !== summary.sessionId ||
        parsedSubject.workspaceId !== summary.workspaceId)
    ) {
      return
    }
    const subject =
      parsedSubject?.kind === 'structured-session'
        ? parsedSubject
        : makeStructuredAgentStatusSubject(
            {
              executionHostId: LOCAL_EXECUTION_HOST_ID,
              wslDistro: null,
              workspaceId: summary.workspaceId,
              workspaceKind:
                parseWorkspaceKey(summary.workspaceId)?.type === 'folder'
                  ? 'folder'
                  : 'git-worktree'
            },
            summary.sessionId
          )
    // The DERIVED pane key, never the orchestration bearer handle or the minted worker pane key:
    // both of those are credentials.
    const paneKey = structuredAgentSessionPaneKey(summary.sessionId)
    // No persisted turn yet: the chat shows nothing, so neither does any status reader.
    if (!summary.status) {
      this.dropStructuredStatus(subject)
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
        subject,
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
  dropStructuredStatus(subject: AgentStatusSubject): void
  dropStructuredStatus(sessionId: string): void
  dropStructuredStatus(subjectOrSessionId: AgentStatusSubject | string): void {
    const subjects =
      typeof subjectOrSessionId === 'string'
        ? Array.from(
            this.state.lastStatusByPaneKey.values(),
            (entry) => (entry as { subject?: AgentStatusSubject }).subject
          ).filter(
            (subject): subject is AgentStatusSubject =>
              subject?.kind === 'structured-session' && subject.sessionId === subjectOrSessionId
          )
        : [subjectOrSessionId]
    for (const subject of subjects) {
      this.dropStatusSubject(subject, { preserveResumeIdentity: false })
    }
  }
}
