import { normalizeHostTurnRevision } from '../../../shared/agent-hook-interrupt-reconciliation'
import { readAgentProcessPresence } from '../../../shared/agent-process-presence'
import { track } from '../../telemetry/client'
import {
  isTurnEndDisposition,
  normalizeAgentStatusPayload
} from '../../../shared/agent-status-types'
import { isTurnEndedAt } from '../../../shared/agent-hook-turn-end-timing'
import { restoreShedStatusFields } from '../../../shared/agent-hook-relay'
import {
  MAX_PANE_KEY_LEN,
  warnOnHookEnvOrVersionMismatch
} from '../../../shared/agent-hook-listener/listener-limits'
import {
  canAcceptClaudeCompactCompletion,
  isClaudeCompactCompletionConsumed,
  markClaudeCompactCompletionConsumed,
  resolveLegacyCompactTrigger
} from '../../../shared/claude-compact-completion'
import { launchTokenHash } from '../../../shared/agent-hook-spool'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  AGENT_STATUS_LEGACY_UNADVERTISED_PEER_CAPABILITIES,
  canAdmitLegacyAgentStatus,
  olderPeerAgentStatusLegacyMode
} from '../../../shared/agent-status-legacy-adapter'
import { isValidPiProviderSessionOnly } from './server-status-identity'
import {
  normalizeRemoteEnvelopeFields,
  type RemoteAgentStatusEnvelope
} from './server-remote-envelope-normalization'
import { AgentHookServerIngestStructuredChildren } from './server-ingest-structured-children'

export abstract class AgentHookServerIngestRemote extends AgentHookServerIngestStructuredChildren {
  /** Relay payloads cross the SSH trust boundary and require canonical validation here. */
  ingestRemote(envelope: RemoteAgentStatusEnvelope, connectionId: string | null): void {
    if (
      !canAdmitLegacyAgentStatus(
        'main-status-update',
        olderPeerAgentStatusLegacyMode(
          envelope?.advertisedAgentStatusCapabilities ??
            AGENT_STATUS_LEGACY_UNADVERTISED_PEER_CAPABILITIES
        )
      )
    ) {
      return
    }
    if (connectionId !== null && typeof connectionId !== 'string') {
      return
    }
    const trimmedConnectionId = connectionId?.trim() ?? null
    if (trimmedConnectionId !== null && trimmedConnectionId.length === 0) {
      return
    }
    if (!envelope || typeof envelope.paneKey !== 'string') {
      return
    }
    // Match HTTP key normalization so local and remote events share one pane.
    const physicalPaneKey = envelope.paneKey.trim()
    let paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN || !parsedPaneKey) {
      return
    }
    if (
      (envelope.isReplay !== undefined && typeof envelope.isReplay !== 'boolean') ||
      (envelope.launchToken !== undefined && typeof envelope.launchToken !== 'string')
    ) {
      return
    }
    // Reject stale relay replay generations against hydrated authority.
    if (envelope.isReplay === true) {
      const expectedLaunchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      const actualLaunchTokenHash = launchTokenHash(envelope.launchToken)
      if (expectedLaunchTokenHash && actualLaunchTokenHash !== expectedLaunchTokenHash) {
        return
      }
    }
    if (envelope.tabId !== undefined && typeof envelope.tabId !== 'string') {
      return
    }
    if (envelope.worktreeId !== undefined && typeof envelope.worktreeId !== 'string') {
      return
    }
    const reportedTabId =
      envelope.tabId !== undefined && envelope.tabId.trim().length > 0
        ? envelope.tabId.trim()
        : undefined
    if (
      paneKey === physicalPaneKey &&
      reportedTabId !== undefined &&
      reportedTabId !== parsedPaneKey.tabId
    ) {
      return
    }
    let tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    const {
      hookEventName,
      source,
      providerPromptId,
      grokPromptBoundary,
      compactTrigger,
      worktreeId,
      promptInteractionKey,
      toolUseId,
      claudeSettledRequests,
      toolAgentId,
      teammateName,
      toolAgentType,
      providerSession
    } = normalizeRemoteEnvelopeFields(envelope)
    if (envelope.statusUnavailable === true && envelope.payload === null) {
      const previous = this.state.lastStatusByPaneKey.get(paneKey)
      if (
        (source === 'opencode' || source === 'opencode2') &&
        previous?.connectionId === trimmedConnectionId &&
        trimmedConnectionId !== null &&
        previous.worktreeId === worktreeId &&
        previous.source === source &&
        previous.launchToken === envelope.launchToken &&
        this.getAgentStatusDisposition(paneKey) !== 'suppress'
      ) {
        this.clearPaneState(paneKey, { statusUnavailable: true })
      }
      return
    }
    const age = envelope.evidenceAgeMs
    if (age !== undefined && (typeof age !== 'number' || !Number.isSafeInteger(age) || age < 0)) {
      return
    }
    const validatedPayload = normalizeAgentStatusPayload(envelope.payload)
    if (!validatedPayload) {
      return
    }
    if (
      envelope.source !== undefined &&
      (source === 'omp' || validatedPayload.agentType === 'omp') &&
      envelope.source !== validatedPayload.agentType
    ) {
      return
    }
    // Restore shed fields only against a matching digest and turn.
    let normalizedPayload = restoreShedStatusFields(
      validatedPayload,
      envelope.shedFields,
      this.state.lastStatusByPaneKey.get(paneKey)?.payload
    )
    if (
      envelope.providerSessionOnly === true &&
      !readAgentProcessPresence(envelope.agentPresence)?.ended &&
      !isValidPiProviderSessionOnly(providerSession, normalizedPayload.agentType)
    ) {
      return
    }
    // Older relays omit source; canonical OMP identity preserves boundary provenance.
    const effectiveSource =
      source ??
      (envelope.source === undefined && validatedPayload.agentType === 'omp' ? 'omp' : undefined)
    const statusDisposition = this.getAgentStatusDisposition(paneKey, {
      source: effectiveSource,
      rawSource: envelope.source,
      hookEventName,
      isReplay: envelope.isReplay === true,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true,
      launchToken: envelope.launchToken,
      retainedLaunchTokenHash: envelope.launchToken?.trim()
        ? undefined
        : this.retainedOwnerLaunchTokenHash(paneKey, {
            worktreeId,
            connectionId: trimmedConnectionId
          })
    })
    if (statusDisposition === 'suppress') {
      return
    }
    const restartedAuthority =
      statusDisposition === 'restart' && effectiveSource === 'omp'
        ? this.restoreRetiredStatusRestart(paneKey)
        : undefined
    if (restartedAuthority && restartedAuthority.paneKey !== paneKey) {
      paneKey = restartedAuthority.paneKey
      tabId = parsePaneKey(paneKey)?.tabId
    }
    if (statusDisposition === 'restart') {
      // Rebind the resolved stable key so a new session cannot inherit retired observation order.
      this.observations.rebind(paneKey)
    }
    const previousStatus = this.state.lastStatusByPaneKey.get(paneKey)
    let acceptedCompactCompletion = false
    if (hookEventName === 'PreCompact' || hookEventName === 'PostCompact') {
      // PreCompact alone proves no completed compact, including on older peers.
      if (hookEventName === 'PreCompact' || source !== 'claude') {
        return
      }
      // Older relays omit the trigger; their state supplies it without bypassing ownership.
      const effectiveTrigger = resolveLegacyCompactTrigger(compactTrigger, normalizedPayload.state)
      // Older relays map auto-compaction to working; it resumes the existing turn and must not mint new work.
      if (effectiveTrigger !== 'manual' || normalizedPayload.agentType !== source) {
        return
      }
      if (
        isClaudeCompactCompletionConsumed(
          this.state.claudeConsumedCompactPromptIdByPaneKey,
          paneKey,
          providerPromptId
        ) ||
        !canAcceptClaudeCompactCompletion(previousStatus, {
          source,
          connectionId: trimmedConnectionId,
          providerPromptId,
          providerSession
        })
      ) {
        return
      }
      markClaudeCompactCompletionConsumed(
        this.state.claudeConsumedCompactPromptIdByPaneKey,
        paneKey,
        providerPromptId
      )
      // Older relays omit the boundary flag; stamp it so compact completion stays silent.
      if (normalizedPayload.sessionBoundary !== true) {
        normalizedPayload = { ...normalizedPayload, sessionBoundary: true }
      }
      acceptedCompactCompletion = true
    }
    // Accepted compact completions retain the summarized turn label, including trigger-stripped replays.
    if (
      source === 'claude' &&
      (compactTrigger !== undefined || acceptedCompactCompletion) &&
      normalizedPayload.prompt.length === 0 &&
      previousStatus?.payload.prompt
    ) {
      normalizedPayload = { ...normalizedPayload, prompt: previousStatus.payload.prompt }
    }
    const applyClaudeBackgroundWork =
      normalizedPayload.agentType === 'claude' &&
      typeof envelope.claudeRunningNonAgentTask === 'boolean' &&
      (envelope.isReplay !== true || !this.runtimeObservedStatusPaneKeys.has(paneKey))
    warnOnHookEnvOrVersionMismatch(this.state, {
      version: envelope.version,
      env: envelope.env,
      expectedEnv: this.env
    })
    const event: AgentHookEventPayload & { authorityRestartId?: string } = {
      paneKey,
      agentPresence: readAgentProcessPresence(envelope.agentPresence),
      source: effectiveSource,
      ...(restartedAuthority?.authorityRestartId
        ? { authorityRestartId: restartedAuthority.authorityRestartId }
        : {}),
      hostTurnRevision: normalizeHostTurnRevision(envelope.hostTurnRevision),
      launchToken: statusDisposition === 'restart' ? undefined : envelope.launchToken,
      tabId,
      worktreeId,
      connectionId: trimmedConnectionId,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
      promptInteractionKey,
      hookEventName,
      providerPromptId,
      grokPromptBoundary,
      compactTrigger,
      toolUseId,
      ...(claudeSettledRequests ? { claudeSettledRequests } : {}),
      toolAgentId,
      teammateName,
      toolAgentType,
      providerSession,
      providerSessionOnly: envelope.providerSessionOnly === true ? true : undefined,
      isReplay: envelope.isReplay === true ? true : undefined,
      ...(isTurnEndedAt(envelope.turnEndedAt) ? { turnEndedAt: envelope.turnEndedAt } : {}),
      ...(isTurnEndDisposition(envelope.turnEndDisposition)
        ? { turnEndDisposition: envelope.turnEndDisposition }
        : {}),
      claudeRunningNonAgentTask:
        typeof envelope.claudeRunningNonAgentTask === 'boolean'
          ? envelope.claudeRunningNonAgentTask
          : undefined,
      payload: normalizedPayload
    }
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(
      event,
      applyClaudeBackgroundWork
        ? () => {
            if (envelope.claudeRunningNonAgentTask) {
              this.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
            } else {
              this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
            }
          }
        : undefined,
      'hook',
      typeof age === 'number' ? Math.max(0, Date.now() - age) : undefined
    )
  }
}
