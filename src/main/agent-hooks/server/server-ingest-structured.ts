import type { StructuredAgentSessionStatusPublisher } from '../../native-chat/agent-session-wire/structured-agent-session-status-ownership'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import {
  continueMainAgentStatus,
  isAgentStatusHeldOpenByChildWork,
  mainAgentTurnInterrupted
} from '../../../shared/agent-lead-status-fold'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import {
  structuredAgentSessionDatedMainAgent,
  structuredAgentSessionRowStateStartedAt
} from '../../../shared/structured-agent-session-status-started-at'
import { structuredStatusLegacyEvent } from './server-structured-status-row'
import { AgentHookServerIngestTerminal } from './server-ingest-terminal'

export abstract class AgentHookServerIngestStructured extends AgentHookServerIngestTerminal {
  withSavedStructuredStatusGroup(
    visit: (sink: StructuredAgentSessionStatusPublisher) => void
  ): void {
    let pendingAt: number | undefined
    const defer = (mutate: (notify: () => void) => void): void => {
      const before = this.statusChangeNotificationVersion
      mutate(() => {
        // Reentrant live notifications already include this committed saved mutation.
        if (before === this.statusChangeNotificationVersion) {
          pendingAt = before
        }
      })
    }
    const flush = (): void => {
      const pending = pendingAt
      pendingAt = undefined
      if (pending !== undefined && pending === this.statusChangeNotificationVersion) {
        this.notifyStatusChangeListeners()
      }
    }
    try {
      visit({
        publish: (summary, subject) =>
          defer((notify) => this.ingestStructuredStatus(summary, subject, notify)),
        forget: (subject) => defer((notify) => this.dropStructuredStatus(subject, notify))
      })
    } catch (error) {
      try {
        flush()
      } catch {
        /* Preserve the original visit failure. */
      }
      throw error
    }
    flush()
  }

  ingestStructuredStatus(
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject,
    notify = () => this.notifyStatusChangeListeners()
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
      this.dropStructuredStatus(parsed, notify)
      return
    }
    const previous = this.canonicalStatusStore.getParent(parsed)
    const priorStatus = previous?.status
    // Read canonical children; the summary's task list loses information.
    const agentStatus = structuredAgentSessionAgentStatus({
      status: summary.status,
      childWork: this.canonicalStatusStore.getChildren(parsed),
      turnOutcome: summary.turnOutcome,
      ...(summary.stopping ? { stopping: summary.stopping } : {})
    })
    const { state, workingMode } = agentStatus
    // Journal dates preserve main-agent continuity across republishing after restart.
    const mainAgent = continueMainAgentStatus(
      priorStatus?.mainAgent,
      structuredAgentSessionDatedMainAgent(agentStatus.mainAgent, summary),
      summary.updatedAt
    )
    const tabId = structuredAgentSessionTabId(parsed.sessionId)
    const paneKey = structuredAgentSessionPaneKey(tabId, parsed.sessionId)
    if (this.state.lastStatusByPaneKey.has(paneKey)) {
      throw new Error('Structured status address conflicts with legacy evidence')
    }
    const snapshot = this.canonicalStatusStore.getRevision()
    const observedAt = Math.max(Date.now(), priorStatus?.receivedAt ?? 0)
    const status: AgentStatusIpcPayload = {
      paneKey,
      tabId,
      worktreeId: parsed.workspaceId,
      connectionId: null,
      structuredHost: summary.hostExecutionOwned ? 'owned' : 'held',
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      state,
      ...(workingMode ? { workingMode } : {}),
      mainAgent,
      // Older readers use interrupted instead of mainAgent.
      interrupted: mainAgentTurnInterrupted(mainAgent),
      prompt: summary.latestPrompt,
      agentType: summary.agent,
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.toolName ? { toolName: summary.toolName } : {}),
      ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
      ...(summary.lastAssistantMessage
        ? { lastAssistantMessage: summary.lastAssistantMessage }
        : {}),
      receivedAt: observedAt,
      // Child-held work needs a live observation clock; the stopped main-agent journal would make it expire.
      evidenceObservedAt: isAgentStatusHeldOpenByChildWork({ state, mainAgent })
        ? observedAt
        : summary.updatedAt,
      // Monitoring becoming a real turn must restart the clock even if state remains working.
      stateStartedAt:
        structuredAgentSessionRowStateStartedAt({ state, mainAgent }, summary) ??
        (priorStatus?.state === state && priorStatus.workingMode === workingMode
          ? priorStatus.stateStartedAt
          : summary.updatedAt),
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
    notify()
    this.emitEnrichedStatus(after)
  }

  /** Only the owning feed can forget a structured row; pane cleanup cannot. */
  dropStructuredStatus(
    subject: AgentStatusStructuredSessionSubject,
    notify = () => this.notifyStatusChangeListeners()
  ): void {
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
      notify()
      this.emitStatusDropped(previous.status.paneKey)
    }
  }
}
