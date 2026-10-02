import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  hookTranscriptPollUpdate,
  shouldPollHookTranscript,
  transcriptPollAnchor
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import { CodexSubagentPollScheduler } from '../../../shared/codex-subagent-poll-scheduler'
import type { EnrichedAgentHookEventPayload } from './server-types'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  CODEX_SUBAGENT_POLL_MS
} from './server-constants'
import { AgentHookServerStatusUpdate } from './server-status-update'

type TranscriptPoll = {
  source: AgentHookSource
  body: unknown
  original: AgentHookEventPayload
}

export abstract class AgentHookServerStatusRetries extends AgentHookServerStatusUpdate {
  private readonly transcriptPollScheduler = new CodexSubagentPollScheduler<TranscriptPoll>(
    CODEX_SUBAGENT_POLL_MS,
    (paneKey, poll) => this.runTranscriptPoll(paneKey, poll)
  )

  protected clearAllTranscriptPolls(): void {
    this.transcriptPollScheduler.clearAll()
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
    this.state.claudeAgentsKilledCursorByPaneKey.delete(paneKey)
  }

  protected scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload
  ): void {
    // Why: a nested CLI of another kind inherits ORCA_PANE_KEY, so clearing here would silently end a live poll.
    if (source !== 'codex' && source !== 'muse' && source !== 'claude') {
      return
    }
    this.transcriptPollScheduler.clear(original.paneKey)
    if (!shouldPollHookTranscript(this.state, source, original)) {
      return
    }
    this.transcriptPollScheduler.schedule(original.paneKey, { source, body, original })
  }

  private runTranscriptPoll(paneKey: string, poll: TranscriptPoll): void {
    const { source, body, original } = poll
    const anchor = transcriptPollAnchor(
      source,
      this.state.lastStatusByPaneKey.get(original.paneKey),
      original
    )
    if (paneKey !== original.paneKey || !this.server || !anchor) {
      return
    }
    const update = hookTranscriptPollUpdate(this.state, source, body, anchor, this.env)
    if (update === null) {
      return
    }
    const next = update ? this.applyNormalizedStatus(update) : anchor
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
        // Why: slug-group discovery can outlive the bounded flush timers; its completion must drive the first retry deterministically.
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
    // Why: some agents POST Stop before their transcript line is flushed; discovery is event-driven, later content retries stay timed.
    this.applyNormalizedStatus(normalized.event, normalized.onAccepted)
  }
}
