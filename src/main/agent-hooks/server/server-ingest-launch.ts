import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { pickParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'

export abstract class AgentHookServerIngestLaunch extends AgentHookServerIngestNormalization {
  /** Seed resume identity before the first hook; Codex SessionStart waits for the first turn (#10923). */
  recordLaunchResumeIdentity(event: LaunchResumeIdentityEvent): void {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey.trim())
    const parsedPaneKey = parsePaneKey(paneKey)
    if (!parsedPaneKey || paneKey.length > MAX_PANE_KEY_LEN) {
      return
    }
    const previous = this.state.lastStatusByPaneKey.get(paneKey)
    // Check saved turn authority before the new process forgets its predecessor's exit.
    const savedIdentity = !previous ? this.paneAgentIdentity(paneKey) : null
    this.forgetAgentExitBefore(paneKey, event.launchedAt)
    const sameConversation =
      previous?.payload.agentType === event.agentType &&
      agentProviderSessionsEqual(event.agentType, previous?.providerSession, event.providerSession)
    if (
      previous &&
      !previous.agentPresence?.ended &&
      (sameConversation ||
        (previous.providerSessionOnly !== true &&
          'receivedAt' in previous &&
          typeof previous.receivedAt === 'number' &&
          previous.receivedAt >= event.launchedAt))
    ) {
      return
    }
    if (
      savedIdentity &&
      !savedIdentity.ended &&
      savedIdentity.status.agentType === event.agentType &&
      sameAgentStatusTerminalOwner(savedIdentity.status, { ...event, connectionId: null }) &&
      agentProviderSessionsEqual(
        event.agentType,
        savedIdentity.status.providerSession,
        event.providerSession
      )
    ) {
      const status = savedIdentity.status
      const recovered: EnrichedAgentHookEventPayload = {
        paneKey,
        tabId: parsedPaneKey.tabId,
        worktreeId: status.worktreeId,
        connectionId: status.connectionId,
        providerSession: event.providerSession,
        receivedAt: status.receivedAt,
        stateStartedAt: status.stateStartedAt,
        evidenceObservedAt: Date.now(),
        payload: pickParsedAgentStatusPayload(status)
      }
      recovered.observation = this.stampObservation(recovered, 'launch', Date.now())
      if (this.writeLegacyStatusRow(recovered)) {
        this.commitStatusRowMutation(undefined, recovered)
        this.scheduleStatusPersist()
        this.notifyStatusChangeListeners()
        this.onAgentStatus?.({ ...recovered, isReplay: true })
      }
      return
    }
    const identity: AgentHookEventPayload &
      Pick<EnrichedAgentHookEventPayload, 'retainedForLiveness'> = {
      paneKey,
      tabId: parsedPaneKey.tabId,
      ...(event.worktreeId?.trim() ? { worktreeId: event.worktreeId.trim() } : {}),
      connectionId: null,
      providerSession: event.providerSession,
      providerSessionOnly: true,
      // Hydration must retain this identity even if no first turn occurs before restart.
      retainedForLiveness: true,
      payload: { state: 'done', prompt: '', agentType: event.agentType }
    }
    this.applyNormalizedStatus(identity, undefined, 'launch')
  }
}
