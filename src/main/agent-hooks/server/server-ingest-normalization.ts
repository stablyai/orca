import { buildSpoolHookBody, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { isAgentHookSource, type AgentHookSource } from '../../../shared/agent-hook-relay'
import type { NormalizedLocalHook } from './server-types'
import { AgentHookServerPersistence } from './server-persistence'

export abstract class AgentHookServerIngestNormalization extends AgentHookServerPersistence {
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
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
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
