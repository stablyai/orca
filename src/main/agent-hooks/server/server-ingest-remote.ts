import { track } from '../../telemetry/client'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status-types'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isAgentHookSource, restoreShedStatusFields } from '../../../shared/agent-hook-relay'
import {
  MAX_PANE_KEY_LEN,
  normalizeClaudePromptId,
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
import { isValidPiProviderSessionOnly } from './server-status-identity'
import { AgentHookServerIngestTerminal } from './server-ingest-terminal'

export abstract class AgentHookServerIngestRemote extends AgentHookServerIngestTerminal {
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
      payload: unknown
    },
    connectionId: string | null
  ): void {
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
    const paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN || !parsedPaneKey) {
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
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    const hookEventName =
      typeof envelope.hookEventName === 'string' && envelope.hookEventName.trim().length > 0
        ? envelope.hookEventName.trim()
        : undefined
    const source = isAgentHookSource(envelope.source) ? envelope.source : undefined
    const providerPromptId =
      source === 'claude' ? normalizeClaudePromptId(envelope.providerPromptId) : undefined
    const compactTrigger =
      source === 'claude' &&
      (envelope.compactTrigger === 'manual' || envelope.compactTrigger === 'auto')
        ? envelope.compactTrigger
        : undefined
    const statusDisposition = this.getAgentStatusDisposition(paneKey, {
      source,
      rawSource: envelope.source,
      hookEventName,
      isReplay: envelope.isReplay === true,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true,
      launchToken: envelope.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    if (statusDisposition === 'restart') {
      // Why: same rebind as the HTTP path — a retired pane taking a new turn is a new session.
      // Why paneKey, not envelope.paneKey: alias resolution already mapped it to the
      // stable pane, so the rebind cannot land on a legacy key.
      this.observations.rebind(paneKey)
    }
    const worktreeId =
      envelope.worktreeId !== undefined && envelope.worktreeId.trim().length > 0
        ? envelope.worktreeId.trim()
        : undefined
    const promptInteractionKey =
      typeof envelope.promptInteractionKey === 'string' &&
      envelope.promptInteractionKey.trim().length > 0
        ? envelope.promptInteractionKey.trim()
        : undefined
    const toolUseId =
      typeof envelope.toolUseId === 'string' && envelope.toolUseId.trim().length > 0
        ? envelope.toolUseId.trim()
        : undefined
    const toolAgentId =
      typeof envelope.toolAgentId === 'string' && envelope.toolAgentId.trim().length > 0
        ? envelope.toolAgentId.trim()
        : undefined
    const teammateName =
      typeof envelope.teammateName === 'string' && envelope.teammateName.trim().length > 0
        ? envelope.teammateName.trim()
        : undefined
    const toolAgentType =
      typeof envelope.toolAgentType === 'string' && envelope.toolAgentType.trim().length > 0
        ? envelope.toolAgentType.trim()
        : undefined
    const providerSession = normalizeAgentProviderSession(envelope.providerSession) ?? undefined
    // Why: relay crosses a trust boundary — re-run the canonical normalizer to enforce caps/invariants (returns null on malformed).
    const validatedPayload = normalizeAgentStatusPayload(envelope.payload)
    if (!validatedPayload) {
      return
    }
    // Why: restore a shed roster only when its digest and turn identity still match the cache.
    let normalizedPayload = restoreShedStatusFields(
      validatedPayload,
      envelope.shedFields,
      this.state.lastStatusByPaneKey.get(paneKey)?.payload
    )
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
      // Why: an older relay built this payload before the boundary flag existed, so it arrives as a
      // plain `done` — which every completion-reactive consumer reads as a finished turn. Stamp the
      // boundary here so a compact stays silent regardless of which relay normalized it.
      if (normalizedPayload.sessionBoundary !== true) {
        normalizedPayload = { ...normalizedPayload, sessionBoundary: true }
      }
      acceptedCompactCompletion = true
    }
    // Why: keyed on "did we accept a completion", not on the trigger surviving the wire — the
    // trigger-stripped replay is exactly the shape that arrives without one, and it is still the
    // compact's own promptless event, so it still needs the summarized turn's label.
    if (
      source === 'claude' &&
      (compactTrigger !== undefined || acceptedCompactCompletion) &&
      normalizedPayload.prompt.length === 0 &&
      previousStatus?.payload.prompt
    ) {
      normalizedPayload = { ...normalizedPayload, prompt: previousStatus.payload.prompt }
    }
    if (
      envelope.providerSessionOnly === true &&
      !isValidPiProviderSessionOnly(providerSession, normalizedPayload.agentType)
    ) {
      return
    }
    const applyClaudeBackgroundWork =
      normalizedPayload.agentType === 'claude' &&
      typeof envelope.claudeRunningNonAgentTask === 'boolean' &&
      // Why: reconnect replay may seed a restarted listener, but cannot override any observation made by this runtime.
      (envelope.isReplay !== true || !this.runtimeObservedStatusPaneKeys.has(paneKey))
    // Why: run the HTTP path's warn-once version/env-mismatch diagnostics with this.env as expected.
    warnOnHookEnvOrVersionMismatch(this.state, {
      version: envelope.version,
      env: envelope.env,
      expectedEnv: this.env
    })
    const event = {
      paneKey,
      source,
      launchToken: statusDisposition === 'restart' ? undefined : envelope.launchToken,
      tabId,
      worktreeId,
      connectionId: trimmedConnectionId,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
      promptInteractionKey,
      hookEventName,
      providerPromptId,
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
    } as AgentHookEventPayload
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
