import { track } from '../../telemetry/client'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status-types'
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
import { normalizeRemoteEnvelopeFields } from './server-remote-envelope-normalization'
import { AgentHookServerIngestStructuredChildren } from './server-ingest-structured-children'

export abstract class AgentHookServerIngestRemote extends AgentHookServerIngestStructuredChildren {
  /** Ingest a payload from the relay JSON-RPC channel (not the local HTTP server); connectionId is stamped here. Main is still the SSH trust boundary, so re-run the canonical normalizer before caching. */
  ingestRemote(
    envelope: {
      paneKey: string
      tabId?: string
      worktreeId?: string
      env?: string
      version?: string
      launchToken?: string
      hasExplicitPrompt?: boolean
      promptInteractionKey?: string
      hookEventName?: string
      source?: unknown
      providerPromptId?: unknown
      grokPromptBoundary?: unknown
      compactTrigger?: unknown
      toolUseId?: string
      toolAgentId?: string
      teammateName?: string
      toolAgentType?: string
      providerSession?: unknown
      providerSessionOnly?: unknown
      isReplay?: boolean
      /** Payload fields the relay dropped to fit an oversized frame; validated below. */
      shedFields?: unknown
      claudeRunningNonAgentTask?: unknown
      /** The producing peer's advertised run-capability set — a property of the peer/connection that built this envelope, not an orthogonal call parameter. Absent (older relay/HTTP paths) defaults to the unadvertised-legacy-peer set. */
      advertisedAgentStatusCapabilities?: readonly string[]
      payload: unknown
    },
    connectionId: string | null
  ): void {
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
    // Why: wire crosses a trust boundary — re-check/trim so an empty connectionId can't poison caches.
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
    // Why: trim paneKey to match the HTTP path, else remote-vs-local events for one pane diverge.
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
    // Why: fence relay spool replay at main so stale generations cannot overwrite hydrated state.
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
    // Why: mirror the HTTP path's readStringField — trim and treat empty-after-trim as undefined.
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
      toolAgentId,
      teammateName,
      toolAgentType,
      providerSession
    } = normalizeRemoteEnvelopeFields(envelope)
    // Why: relay crosses a trust boundary — re-run the canonical normalizer to enforce caps/invariants (returns null on malformed).
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
    // Why: restore a shed roster only when its digest and turn identity still match the cache.
    let normalizedPayload = restoreShedStatusFields(
      validatedPayload,
      envelope.shedFields,
      this.state.lastStatusByPaneKey.get(paneKey)?.payload
    )
    if (
      envelope.providerSessionOnly === true &&
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
      launchToken: envelope.launchToken
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
      // Why: same rebind as the HTTP path — a retired pane taking a new turn is a new session.
      // Why paneKey, not envelope.paneKey: alias resolution already mapped it to the
      // stable pane, so the rebind cannot land on a legacy key.
      this.observations.rebind(paneKey)
    }
    const previousStatus = this.state.lastStatusByPaneKey.get(paneKey)
    let acceptedCompactCompletion = false
    if (hookEventName === 'PreCompact' || hookEventName === 'PostCompact') {
      // Why: PreCompact is never registered and proves nothing (an aborted compact emits it alone);
      // reject it here too so a host on any version cannot drive pane state from it.
      if (hookEventName === 'PreCompact' || source !== 'claude') {
        return
      }
      // Why: a relay predating this change strips `compactTrigger` from its cached PostCompact
      // before replaying it, so the replay has no manual/auto discriminator. That relay's mapping is
      // fixed and known — manual produced `done`, auto produced `working` — so the payload state
      // stands in for the missing trigger. Trigger substitution only; ownership is still checked.
      const effectiveTrigger = resolveLegacyCompactTrigger(compactTrigger, normalizedPayload.state)
      // Why: an auto compact happens inside a turn that resumes and emits its own Stop. An older
      // relay maps it to `working`, and this ingest applies the relay's payload verbatim — so
      // without this drop, every auto compact on such a host mints exactly the stuck `working` this
      // change removes.
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
    // Why: run the HTTP path's warn-once version/env-mismatch diagnostics with this.env as expected.
    warnOnHookEnvOrVersionMismatch(this.state, {
      version: envelope.version,
      env: envelope.env,
      expectedEnv: this.env
    })
    const event: AgentHookEventPayload & { authorityRestartId?: string } = {
      paneKey,
      source: effectiveSource,
      ...(restartedAuthority?.authorityRestartId
        ? { authorityRestartId: restartedAuthority.authorityRestartId }
        : {}),
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
      toolAgentId,
      teammateName,
      toolAgentType,
      providerSession,
      providerSessionOnly: envelope.providerSessionOnly === true ? true : undefined,
      isReplay: envelope.isReplay === true ? true : undefined,
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
        : undefined
    )
  }
}
