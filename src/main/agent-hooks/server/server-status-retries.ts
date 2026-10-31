import { ClaudeHelperKillPoller } from '../../../shared/agent-hook-listener/providers/claude-helper-kill-poller'
import { pollCodexTranscriptStatus } from '../../../shared/agent-hook-listener/providers/codex-transcript-poll'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { pickHostTurnEnd } from '../../../shared/agent-status-types'
import {
  shouldPollHookTranscript,
  hookTranscriptWatchPath,
  transcriptPollUpdate
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import { AgentTranscriptPollScheduler } from '../../../shared/agent-transcript-poll-scheduler'
import type { EnrichedAgentHookEventPayload, IncomingAgentHookEvent } from './server-types'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  CODEX_SUBAGENT_POLL_MS
} from './server-constants'
import { AgentHookServerStatusUpdate } from './server-status-update'

type TranscriptPoll = {
  source: AgentHookSource
  body: unknown
  original: EnrichedAgentHookEventPayload
}

export abstract class AgentHookServerStatusRetries extends AgentHookServerStatusUpdate {
  private observedLocalHook?: { accepted: boolean; receivedAt?: number }
  private readonly claudeHelperKills = new ClaudeHelperKillPoller(this.state, {
    current: (paneKey) => this.state.lastStatusByPaneKey.get(paneKey),
    publish: (event) => {
      this.applyNormalizedStatus(event)
    },
    listening: () =>
      this.server?.listening === true && this.statusHooksEnabled && this.ownerStateInitialized
  })

  private readonly transcriptPollScheduler = new AgentTranscriptPollScheduler<TranscriptPoll>(
    CODEX_SUBAGENT_POLL_MS,
    (paneKey, poll) => this.runTranscriptPoll(paneKey, poll)
  )

  protected applyObservedLocalHook(
    incoming: IncomingAgentHookEvent,
    onAccepted?: () => void,
    receivedAt?: number
  ): EnrichedAgentHookEventPayload | undefined {
    const previous = this.observedLocalHook
    const context = { accepted: false, receivedAt }
    this.observedLocalHook =
      incoming.payload.agentType === 'claude' && incoming.connectionId === null
        ? context
        : undefined
    try {
      return this.applyNormalizedStatus(incoming, () => {
        onAccepted?.()
        context.accepted = true
      })
    } finally {
      this.observedLocalHook = previous
    }
  }

  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    const hook = this.observedLocalHook
    // Held/restated rows retain their stamp; only a newly admitted typed hook owns observation.
    if (hook?.accepted) {
      hook.accepted = false
      if (after?.observation?.origin === 'hook' && after.observation !== before?.observation) {
        this.claudeHelperKills.schedule(after, hook.receivedAt)
      }
    }
    return super.commitStatusRowMutation(before, after, emit)
  }

  protected activateClaudeHelperObservations(): void {
    this.claudeHelperKills.activate()
  }

  protected clearAllTranscriptPolls(): void {
    this.transcriptPollScheduler.clearAll()
    this.claudeHelperKills.clearAll()
  }

  protected clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  protected clearTranscriptPoll(paneKey: string): void {
    this.transcriptPollScheduler.clear(paneKey)
    this.claudeHelperKills.clear(paneKey)
  }

  protected scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    if (source === 'claude') {
      return
    }
    // Nested CLIs inherit pane keys; another provider must not clear this transcript poll.
    if (source !== 'codex' && source !== 'muse') {
      return
    }
    if (!shouldPollHookTranscript(this.state, source, original)) {
      this.transcriptPollScheduler.clear(original.paneKey)
      return
    }
    this.transcriptPollScheduler.schedule(
      original.paneKey,
      { source, body, original },
      hookTranscriptWatchPath(this.state, source, original.paneKey)
    )
  }

  private runTranscriptPoll(paneKey: string, poll: TranscriptPoll): void {
    const { source, body, original } = poll
    // Recheck ownership at callback time; newer events supersede this payload even if children remain.
    if (
      paneKey !== original.paneKey ||
      !this.server ||
      this.state.lastStatusByPaneKey.get(original.paneKey) !== original
    ) {
      return
    }
    const normalized =
      source === 'codex'
        ? pollCodexTranscriptStatus(this.state, original, body, this.env)
        : normalizeHookPayload(this.state, source, body, this.env)
    if (!normalized) {
      return
    }
    const update = transcriptPollUpdate(source, original, normalized)
    const next = update ? this.applyNormalizedStatus(update) : original
    if (next) {
      this.scheduleTranscriptPoll(source, body, next)
    }
  }

  protected scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt = 1,
    discoveryReady = false
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        // Discovery may outlast flush timers; retry as soon as it completes.
        void discovery
          .then(() => {
            if (this.server) {
              this.applyAssistantMessageRetry(source, body, original, 1, true)
            }
          })
          .catch((err) => {
            console.error('[agent-hooks] Grok result discovery failed:', err)
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(source, body, original, attempt + 1, discoveryReady)
      } catch (err) {
        console.error('[agent-hooks] assistant message retry failed:', err)
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  protected applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.state.lastStatusByPaneKey.get(original.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const normalized = this.normalizeLocalHookPayload(source, body)
    if (!normalized.event?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(source, body, original, nextAttempt, requireExactOriginal)
      return
    }
    // Stop can precede transcript flush; retries add text while preserving the same turn end.
    this.applyNormalizedStatus(
      { ...normalized.event, ...pickHostTurnEnd(current) },
      normalized.onAccepted
    )
  }
}
