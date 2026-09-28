import { parsePaneKey } from '../../../shared/stable-pane-id'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import type { NormalizedLocalHook } from './server-types'
import { AgentHookServerOpenCodeBinder } from './server-opencode-binder'

export abstract class AgentHookServerIngestNormalization extends AgentHookServerOpenCodeBinder {
  protected setClaudeBackgroundEvidence(
    paneKey: string,
    hasRunningTask: boolean,
    hasActiveCron: boolean
  ): void {
    if (hasRunningTask) {
      this.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    } else {
      this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    }
    if (hasActiveCron) {
      this.state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  }

  protected normalizeLocalHookPayload(source: AgentHookSource, body: unknown): NormalizedLocalHook {
    if (source !== 'claude' || typeof body !== 'object' || body === null) {
      const event = normalizeHookPayload(this.state, source, body, this.env)
      if (
        event &&
        (source === 'opencode' || source === 'mimo-code') &&
        event.hookEventName === 'SessionStart'
      ) {
        // Why: a birth just arrived; bind it now instead of waiting out the poll interval.
        this.kickOpenCodeBinder()
      }
      return { event }
    }
    const rawPaneKey = (body as Record<string, unknown>).paneKey
    const paneKey = typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    if (!paneKey) {
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
    }
    const previousRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const previousActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const event = normalizeHookPayload(this.state, source, body, this.env)
    const nextRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const nextActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this.setClaudeBackgroundEvidence(paneKey, previousRunningTask, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Why: nested CLIs may inherit the pane key; only accepted statuses may mutate its background-work gate.
    return {
      event,
      onAccepted: () => this.setClaudeBackgroundEvidence(paneKey, nextRunningTask, nextActiveCron)
    }
  }

  /** The one ingest path for a hook body, whichever transport carried it: an HTTP POST, a record
   *  committed to the hook inbox, or a legacy spool line. A replay is durable evidence committed
   *  while nothing was draining, not a live observation. */
  protected ingestHookBody(
    source: AgentHookSource,
    rawBody: unknown,
    options: { isReplay?: boolean } = {}
  ): void {
    const body = this.normalizeHookBodyPaneKeyAlias(rawBody)
    const normalized = this.normalizeLocalHookPayload(source, body)
    if (!normalized.event) {
      return
    }
    const observed = options.isReplay
      ? { ...normalized.event, isReplay: true as const }
      : normalized.event
    const statusDisposition = this.getAgentStatusDisposition(observed.paneKey, {
      source,
      hookEventName: observed.hookEventName,
      isReplay: observed.isReplay,
      hasExplicitPrompt: observed.hasExplicitPrompt,
      launchToken: observed.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    const restartedAuthority =
      statusDisposition === 'restart' && source === 'omp'
        ? this.restoreRetiredStatusRestart(observed.paneKey)
        : undefined
    const event =
      statusDisposition === 'restart'
        ? {
            ...observed,
            launchToken: undefined,
            ...(restartedAuthority
              ? { ...restartedAuthority, tabId: parsePaneKey(restartedAuthority.paneKey)?.tabId }
              : {})
          }
        : observed
    if (statusDisposition === 'restart') {
      // Why: a retired pane accepting a new turn is a different agent session behind the
      // same key — later observations must not be ordered against the retired one.
      this.observations.rebind(event.paneKey)
    }
    this.recordCurrentAuthorityObservation(event)
    const enriched = this.applyNormalizedStatus(event, normalized.onAccepted)
    if (options.isReplay) {
      if (event.payload.state !== 'done') {
        this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
      }
      return
    }
    if (enriched) {
      this.scheduleAssistantMessageRetry(source, body, enriched)
      this.scheduleTranscriptPoll(source, body, enriched)
    }
  }
}
