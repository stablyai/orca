import { hasCodexTranscriptSubagents } from '../../../shared/agent-hook-listener/providers/codex-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { CodexSubagentPollScheduler } from '../../../shared/codex-subagent-poll-scheduler'
import type { EnrichedAgentHookEventPayload } from './server-types'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  CODEX_SUBAGENT_POLL_MS
} from './server-constants'
import { AgentHookServerStatusUpdate } from './server-status-update'

type CodexSubagentPoll = {
  source: AgentHookSource
  body: unknown
  original: EnrichedAgentHookEventPayload
}

export abstract class AgentHookServerStatusRetries extends AgentHookServerStatusUpdate {
  private readonly codexSubagentPollScheduler = new CodexSubagentPollScheduler<CodexSubagentPoll>(
    CODEX_SUBAGENT_POLL_MS,
    (paneKey, poll) => this.runCodexSubagentPoll(paneKey, poll)
  )

  protected clearAllCodexSubagentPolls(): void {
    this.codexSubagentPollScheduler.clearAll()
  }

  protected clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  protected clearCodexSubagentPoll(paneKey: string): void {
    this.codexSubagentPollScheduler.clear(paneKey)
  }

  protected scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    // Why: a nested non-codex CLI inherits ORCA_PANE_KEY, so clearing here would silently end a live codex poll.
    if (source !== 'codex') {
      return
    }
    this.codexSubagentPollScheduler.clear(original.paneKey)
    if (!hasCodexTranscriptSubagents(this.state, original.paneKey)) {
      return
    }
    this.codexSubagentPollScheduler.schedule(original.paneKey, { source, body, original })
  }

  private runCodexSubagentPoll(paneKey: string, poll: CodexSubagentPoll): void {
    const { source, body, original } = poll
    // Keep the identity check at callback time: a newer event supersedes this
    // payload even when its pane still has transcript children.
    if (
      paneKey !== original.paneKey ||
      !this.server ||
      this.state.lastStatusByPaneKey.get(original.paneKey) !== original
    ) {
      return
    }
    const normalized = normalizeHookPayload(this.state, source, body, this.env)
    if (!normalized) {
      return
    }
    const subagentsChanged =
      JSON.stringify(normalized.payload.subagents) !== JSON.stringify(original.payload.subagents)
    const next = subagentsChanged ? this.applyNormalizedStatus(normalized) : original
    this.scheduleCodexSubagentPoll(source, body, next)
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
