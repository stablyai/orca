import { retainOpenCodeWriterTopology } from './cli-writer-observation'
import { buildSpoolHookBody, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { checkHookOwnerPresence } from '../../../shared/agent-hook-owner-presence'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { isAgentHookSource, type AgentHookSource } from '../../../shared/agent-hook-relay'
import {
  bindOpenCodeTuiSession,
  isOpenCodeSharedServerPost
} from '../../../shared/agent-hook-listener/opencode-session-registry'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'
import { isUnusedClaudeSettlement } from './server-claude-status-rules'
import { AgentHookServerTmuxStatus } from './server-tmux-status'
import { getClaudeObservedConfigDirs } from '../../claude-accounts/claude-profile-installed-router'

export abstract class AgentHookServerIngestNormalization extends AgentHookServerTmuxStatus {
  protected override applyNormalizedStatus(
    ...args: Parameters<AgentHookServerTmuxStatus['applyNormalizedStatus']>
  ): EnrichedAgentHookEventPayload | undefined {
    const applied = super.applyNormalizedStatus(...args)
    const [incoming, , origin = 'hook'] = args
    // Claude can still block the prompt after this hook, and its idle may already have landed.
    if (
      applied?.payload.agentType === 'claude' &&
      origin === 'hook' &&
      incoming.hookEventName === 'UserPromptSubmit' &&
      this.programStatusFacets.claimPrompt(applied.paneKey)
    ) {
      this.settleClaudePromptBlocked(applied)
    }
    return applied
  }

  /** A live batch that settles no held bound request is main's no-op: it must not become the row. */
  protected dropsClaudeSettlement(
    paneKey: string,
    event: Parameters<typeof isUnusedClaudeSettlement>[1]
  ): boolean {
    return isUnusedClaudeSettlement(this.state.lastStatusByPaneKey.get(paneKey), event)
  }

  /** An OpenCode relay that lost status retires only the row its own connection and launch wrote. */
  protected clearUnavailableRemoteStatus(
    paneKey: string,
    connectionId: string | null,
    source: AgentHookSource | undefined,
    worktreeId: string | undefined,
    envelope: { launchToken?: string }
  ): void {
    const previous = this.state.lastStatusByPaneKey.get(paneKey)
    if (
      (source === 'opencode' || source === 'opencode2') &&
      previous?.connectionId === connectionId &&
      connectionId !== null &&
      previous.worktreeId === worktreeId &&
      previous.source === source &&
      previous.launchToken === envelope.launchToken &&
      this.getAgentStatusDisposition(paneKey) !== 'suppress'
    ) {
      this.clearPaneState(paneKey, { statusUnavailable: true })
    }
  }

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

  protected normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown,
    isReplay = false
  ): NormalizedLocalHook {
    if (source !== 'claude' || typeof body !== 'object' || body === null) {
      const event = normalizeHookPayload(this.state, source, body, this.env, {
        admitOpenCodeTui: (identity) => {
          const disposition = this.getAgentStatusDisposition(identity.paneKey, {
            ...identity,
            source,
            isReplay
          })
          if (disposition === 'restart') {
            this.observations.rebind(identity.paneKey)
          }
          return disposition !== 'suppress'
        }
      })
      retainOpenCodeWriterTopology(event, source, body)
      if (
        event &&
        event.hookEventName === 'SessionStart' &&
        isOpenCodeSharedServerPost(source, body)
      ) {
        this.kickOpenCodeBinder()
      }
      return {
        event,
        onAccepted: () =>
          bindOpenCodeTuiSession(this.state, source, body, event?.providerSession?.id)
      }
    }
    const rawPaneKey = (body as Record<string, unknown>).paneKey
    const paneKey = typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    if (!paneKey) {
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
    }
    const previousRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const previousActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const normalized = normalizeHookPayload(this.state, source, body, this.env)
    const event =
      normalized && this.dropsClaudeSettlement(normalized.paneKey, normalized) ? null : normalized
    const transcriptPath = event?.providerSession?.transcriptPath
    if (transcriptPath) {
      // A wrapper's CLAUDE_CONFIG_DIR is only visible here; History scans it too (#23505).
      getClaudeObservedConfigDirs()?.observeTranscriptPath(transcriptPath)
    }
    const nextRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const nextActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this.setClaudeBackgroundEvidence(paneKey, previousRunningTask, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Nested CLIs inherit pane keys; rejected status must not change the owner's background-work gate.
    return {
      event,
      onAccepted: () => this.setClaudeBackgroundEvidence(paneKey, nextRunningTask, nextActiveCron)
    }
  }

  // Spool records are durable replay evidence, not a live observation.
  protected ingestSpoolRecord(record: SpoolRecord): Promise<void> | void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    const apply = () => {
      if (
        !this.statusHooksEnabled ||
        this.token !== token ||
        this.statusHookGeneration !== statusHookGeneration
      ) {
        throw new Error('Status hook spool replay interrupted')
      }
      this.applySpoolHook(record, body)
    }
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const pending = checkHookOwnerPresence(this.state, record.source, body, this.env, (paneKey) =>
      this.checkAgentPresence(paneKey)
    )
    return pending ? pending.then(apply) : apply()
  }

  private applySpoolHook(record: SpoolRecord, body: unknown): void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const normalized = this.normalizeLocalHookPayload(record.source, body, true)
    if (!normalized.event) {
      return
    }
    const exit = this.agentExitedAtByPaneKey.get(this.resolvePaneKeyAlias(normalized.event.paneKey))
    // Whole-second spool timestamps prove pre-exit ownership only with a full second of separation.
    if (exit && record.receivedAt + 1000 <= exit.at) {
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
    this.applyObservedLocalHook(event, normalized.onAccepted, record.receivedAt)
    if (event.payload.state !== 'done') {
      this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
    }
  }
}
