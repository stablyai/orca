import { buildSpoolHookBody, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { isAgentHookSource, type AgentHookSource } from '../../../shared/agent-hook-relay'
import { catchUpOnClaudeTranscript } from '../../../shared/agent-hook-listener/providers/claude-transcript-watch'
import type { ClaudeNonAgentWork } from '../../../shared/agent-hook-listener/providers/claude-non-agent-work'
import type { NormalizedLocalHook } from './server-types'
import { AgentHookServerOpenCodeBinder } from './server-opencode-binder'

export abstract class AgentHookServerIngestNormalization extends AgentHookServerOpenCodeBinder {
  /** Records are replaced whole, never mutated, so the snapshot is a reference. */
  protected setClaudeBackgroundEvidence(
    paneKey: string,
    nonAgentWork: ClaudeNonAgentWork | undefined,
    hasActiveCron: boolean
  ): void {
    if (nonAgentWork) {
      this.state.claudeNonAgentWorkByPaneKey.set(paneKey, nonAgentWork)
    } else {
      this.state.claudeNonAgentWorkByPaneKey.delete(paneKey)
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
    // Why before the snapshot: a fact the cursor has passed must not roll back with an event the
    // store then refuses. It only reads an existing cursor; spool replays after a restart find none.
    catchUpOnClaudeTranscript(this.state, paneKey)
    const previousNonAgentWork = this.state.claudeNonAgentWorkByPaneKey.get(paneKey)
    const previousActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const event = normalizeHookPayload(this.state, source, body, this.env)
    const nextNonAgentWork = this.state.claudeNonAgentWorkByPaneKey.get(paneKey)
    const nextActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this.setClaudeBackgroundEvidence(paneKey, previousNonAgentWork, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Why: nested CLIs may inherit the pane key; only accepted statuses may mutate its background-work gate.
    return {
      event,
      onAccepted: () => this.setClaudeBackgroundEvidence(paneKey, nextNonAgentWork, nextActiveCron)
    }
  }

  // Spool records are durable replay evidence, not a live observation.
  protected ingestSpoolRecord(record: SpoolRecord): void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const normalized = this.normalizeLocalHookPayload(record.source, body)
    if (!normalized.event) {
      return
    }
    const replay = { ...normalized.event, isReplay: true as const }
    const statusDisposition = this.getAgentStatusDisposition(replay.paneKey, {
      source: record.source,
      hookEventName: replay.hookEventName,
      isReplay: true,
      hasExplicitPrompt: replay.hasExplicitPrompt,
      launchToken: replay.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    const event = statusDisposition === 'restart' ? { ...replay, launchToken: undefined } : replay
    if (statusDisposition === 'restart') {
      this.observations.rebind(event.paneKey)
    }
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(event, normalized.onAccepted)
    if (event.payload.state !== 'done') {
      this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
    }
  }
}
