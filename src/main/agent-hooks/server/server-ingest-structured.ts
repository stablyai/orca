import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { structuredStatusLegacyEvent } from './server-structured-status-row'
import { AgentHookServerIngestTerminal } from './server-ingest-terminal'

export abstract class AgentHookServerIngestStructured extends AgentHookServerIngestTerminal {
  ingestStructuredStatus(
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ): void {
    const parsed = parseAgentStatusSubject(subject)
    if (
      !parsed ||
      parsed.kind !== 'structured-session' ||
      parsed.sessionId !== summary.sessionId ||
      parsed.workspaceId !== summary.workspaceId ||
      !Number.isFinite(summary.updatedAt) ||
      summary.updatedAt < 0
    ) {
      throw new Error('Structured status does not match its trusted owner subject')
    }
    if (!summary.status) {
      this.dropStructuredStatus(parsed)
      return
    }
    const previous = this.canonicalStatusStore.getParent(parsed)
    const priorStatus = previous?.status
    const state = structuredAgentSessionStatusState(summary.status)
    const tabId = structuredAgentSessionTabId(parsed.sessionId)
    const paneKey = structuredAgentSessionPaneKey(tabId, parsed.sessionId)
    if (this.state.lastStatusByPaneKey.has(paneKey)) {
      throw new Error('Structured status address conflicts with legacy evidence')
    }
    const snapshot = this.canonicalStatusStore.getSnapshot()
    const status: AgentStatusIpcPayload = {
      paneKey,
      tabId,
      worktreeId: parsed.workspaceId,
      connectionId: null,
      structuredHost: summary.hostExecutionOwned ? 'owned' : 'held',
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      state,
      prompt: summary.latestPrompt,
      agentType: summary.agent,
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.toolName ? { toolName: summary.toolName } : {}),
      ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
      ...(summary.lastAssistantMessage
        ? { lastAssistantMessage: summary.lastAssistantMessage }
        : {}),
      receivedAt: Math.max(Date.now(), priorStatus?.receivedAt ?? 0),
      evidenceObservedAt: summary.updatedAt,
      stateStartedAt: priorStatus?.state === state ? priorStatus.stateStartedAt : summary.updatedAt,
      observation: {
        origin: 'structured',
        kind: 'transition',
        authorityId: snapshot.epoch,
        incarnation: 0,
        revision: snapshot.revision + 1,
        observedAt: summary.updatedAt
      }
    }
    const publication = this.canonicalStatusStore.applyMutation({
      parent: { subject: parsed, status, firstObservedAt: previous?.firstObservedAt ?? Date.now() }
    })
    if (!publication) {
      return
    }
    const key = serializeAgentStatusSubject(parsed)
    const subjects =
      this.canonicalSubjectsByPane.get(paneKey) ??
      new Map<string, AgentStatusStructuredSessionSubject>()
    subjects.set(key, parsed)
    this.canonicalSubjectsByPane.set(paneKey, subjects)
    if (!this.canonicalListingOrder.has(key)) {
      this.canonicalListingOrder.set(key, this.nextStatusListingOrder())
    }
    const committed = this.canonicalStatusStore.getParent(parsed)?.status
    if (!committed) {
      throw new Error('Committed structured status is missing')
    }
    const after = structuredStatusLegacyEvent(committed)
    this.commitStatusRowMutation(priorStatus && structuredStatusLegacyEvent(priorStatus), after)
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(after)
  }

  /** Pane cleanup never resolves a canonical subject; only its owning feed can forget this row. */
  dropStructuredStatus(subject: AgentStatusStructuredSessionSubject): void {
    const parsed = parseAgentStatusSubject(subject)
    if (!parsed || parsed.kind !== 'structured-session') {
      throw new Error('Structured status removal requires its exact owner subject')
    }
    const previous = this.canonicalStatusStore.getParent(parsed)
    if (!previous) {
      return
    }
    const publication = this.canonicalStatusStore.applyMutation({
      removeParent: parsed
    })
    if (!publication) {
      return
    }
    const key = serializeAgentStatusSubject(parsed)
    this.canonicalListingOrder.delete(key)
    if (previous.status) {
      const subjects = this.canonicalSubjectsByPane.get(previous.status.paneKey)
      subjects?.delete(key)
      if (subjects?.size === 0) {
        this.canonicalSubjectsByPane.delete(previous.status.paneKey)
      }
      this.commitStatusRowMutation(structuredStatusLegacyEvent(previous.status), undefined)
      this.notifyStatusChangeListeners()
      this.emitStatusDropped(previous.status.paneKey)
    }
  }
}
