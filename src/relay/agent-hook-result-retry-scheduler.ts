// Deferred re-normalization timers for late-arriving agent results: the transcript hadn't caught up
// when the hook fired, so re-read the same body on a timer and re-apply only if it changed. Both
// timer families live in one owner so pane teardown and server stop tear both down in one ordered
// place before the listener caches are cleared.
import { hasCodexTranscriptSubagents } from '../shared/agent-hook-listener/providers/codex-state'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../shared/agent-hook-listener/grok-result-discovery'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { CodexSubagentPollScheduler } from '../shared/codex-subagent-poll-scheduler'

const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
const ASSISTANT_MESSAGE_RETRY_MS = 50
const CODEX_SUBAGENT_POLL_MS = 1_000

type CodexSubagentPoll = {
  source: AgentHookSource
  body: unknown
  original: AgentHookEventPayload
  env?: string
  version?: string
}

export type AgentHookResultRetryHost = {
  state: HookListenerState
  env: string
  /** Why: must be read live — a retry armed before stop() must not resurrect on a downed server. */
  isListening: () => boolean
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string
  ) => void
}

export class AgentHookResultRetryScheduler {
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private codexSubagentPollScheduler: CodexSubagentPollScheduler<CodexSubagentPoll>
  private host: AgentHookResultRetryHost

  constructor(host: AgentHookResultRetryHost) {
    this.host = host
    this.codexSubagentPollScheduler = new CodexSubagentPollScheduler(
      CODEX_SUBAGENT_POLL_MS,
      (paneKey, poll) => this.runCodexSubagentPoll(paneKey, poll)
    )
  }

  clearAll(): void {
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    this.codexSubagentPollScheduler.clearAll()
  }

  clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  clearCodexSubagentPoll(paneKey: string): void {
    this.codexSubagentPollScheduler.clear(paneKey)
  }

  scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string
  ): void {
    // Why: a nested non-codex CLI inherits ORCA_PANE_KEY, so clearing here would silently end a live codex poll.
    if (source !== 'codex') {
      return
    }
    this.codexSubagentPollScheduler.clear(original.paneKey)
    if (!hasCodexTranscriptSubagents(this.host.state, original.paneKey)) {
      return
    }
    this.codexSubagentPollScheduler.schedule(original.paneKey, {
      source,
      body,
      original,
      env,
      version
    })
  }

  private runCodexSubagentPoll(paneKey: string, poll: CodexSubagentPoll): void {
    const { source, body, original, env, version } = poll
    // Keep the identity check at callback time: a newer event supersedes this
    // payload even when its pane still has transcript children.
    if (
      paneKey !== original.paneKey ||
      !this.host.isListening() ||
      this.host.state.lastStatusByPaneKey.get(original.paneKey) !== original
    ) {
      return
    }
    const event = normalizeHookPayload(this.host.state, source, body, this.host.env)
    if (!event) {
      return
    }
    const subagentsChanged =
      JSON.stringify(event.payload.subagents) !== JSON.stringify(original.payload.subagents)
    const next = subagentsChanged ? event : original
    if (subagentsChanged) {
      this.host.applyEvent(event, source, env, version)
    }
    this.scheduleCodexSubagentPoll(source, body, next, env, version)
  }

  scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string,
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
        // Why: slug-group discovery can outlive the bounded flush timers, so its completion drives the first retry.
        void discovery
          .then(() => {
            if (this.host.isListening()) {
              this.applyAssistantMessageRetry(source, body, original, env, version, 1, true)
            }
          })
          .catch((err) => {
            process.stderr.write(
              `[relay-hook-server] Grok result discovery failed: ${err instanceof Error ? err.message : String(err)}\n`
            )
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(
          source,
          body,
          original,
          env,
          version,
          attempt + 1,
          discoveryReady
        )
      } catch (err) {
        process.stderr.write(
          `[relay-hook-server] assistant message retry failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env: string | undefined,
    version: string | undefined,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.host.state.lastStatusByPaneKey.get(original.paneKey)
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const event = normalizeHookPayload(this.host.state, source, body, this.host.env)
    if (!event?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(
        source,
        body,
        original,
        env,
        version,
        nextAttempt,
        requireExactOriginal
      )
      return
    }
    this.host.applyEvent(event, source, env, version)
  }
}
