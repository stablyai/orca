import {
  withHookTranscriptPoll,
  normalizeHookTranscriptPoll,
  type HookTranscriptPollReads
} from '../../../shared/agent-hook-listener/transcripts/hook-transcript-poll-reads'
import { ClaudeHelperKillPoller } from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-helper-kill-poller'
import { retainTmuxHookWriterTopology } from './cli-writer-observation'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { pickHostTurnEnd } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  ignoredHookTranscriptPoll,
  museLogOffset,
  nextHookTranscriptPollDelay,
  scheduleHookTranscriptPoll,
  transcriptPollUpdate
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import { AgentTranscriptPollScheduler } from '../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'
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
  delayMs?: number
}

export abstract class AgentHookServerStatusRetries extends AgentHookServerStatusUpdate {
  private observedLocalHook?: { accepted: boolean; receivedAt?: number }
  private readonly claudeHelperKills = new ClaudeHelperKillPoller(this.state, {
    current: (paneKey) => this.state.lastStatusByPaneKey.get(paneKey),
    publish: (event) => {
      this.applyRestatedStatus(event)
    },
    listening: () =>
      this.server?.listening === true && this.statusHooksEnabled && this.ownerStateInitialized
  })

  private readonly transcriptPollScheduler = new AgentTranscriptPollScheduler<TranscriptPoll>(
    CODEX_SUBAGENT_POLL_MS,
    (paneKey, poll, wanted) => this.runTranscriptPoll(paneKey, poll, wanted)
  )

  protected readonly replayTranscriptPolls = new Map<
    string,
    { source: AgentHookSource; body: unknown; original?: EnrichedAgentHookEventPayload }
  >()

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
    this.replayTranscriptPolls.clear()
    this.transcriptPollScheduler.clearAll()
    this.claudeHelperKills.clearAll()
  }

  protected clearAssistantMessageRetry(paneKey: string): void {
    clearTimeout(this.assistantMessageRetryTimers.get(paneKey))
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  protected clearTranscriptPoll(paneKey: string): void {
    this.replayTranscriptPolls.delete(paneKey)
    this.transcriptPollScheduler.clear(paneKey)
    this.claudeHelperKills.clear(paneKey)
  }

  protected replaceTranscriptPollRow(
    previous: EnrichedAgentHookEventPayload,
    next: EnrichedAgentHookEventPayload
  ): void {
    // Identity settlement replaces rows, including replayed ones still waiting for the server to bind.
    for (const poll of [
      this.transcriptPollScheduler.peek(previous.paneKey),
      this.replayTranscriptPolls.get(previous.paneKey)
    ]) {
      if (poll?.original === previous && next.paneKey === previous.paneKey) {
        poll.original = next
      }
    }
  }

  protected scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    delayMs?: number
  ): void {
    scheduleHookTranscriptPoll(this.transcriptPollScheduler, this.state, {
      source,
      body,
      original,
      delayMs
    })
  }

  protected rearmIgnoredHook(source: AgentHookSource, body: unknown): void {
    const poll = ignoredHookTranscriptPoll(this.state, source, body, this.env, (key) =>
      this.transcriptPollScheduler.peek(key)
    )
    if (poll) {
      this.scheduleTranscriptPoll(
        poll.source,
        poll.body,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main stores enriched accepted rows; the shared view exposes their base event type.
        poll.original as EnrichedAgentHookEventPayload
      )
    }
  }

  private runTranscriptPoll(
    paneKey: string,
    poll: TranscriptPoll,
    wanted: () => boolean
  ): void | Promise<void> {
    if (!this.ownsTranscriptPoll(paneKey, poll)) {
      return
    }
    if (poll.source !== 'codex' && poll.source !== 'antigravity') {
      this.applyTranscriptPoll(paneKey, poll, undefined)
      return
    }
    // Why: rollout reads stay off the main thread (#43539); the next tick waits for this one.
    const server = this.server
    const generation = this.statusHookGeneration
    const currentOwner = () => {
      const current = this.transcriptPollScheduler.peek(paneKey)
      return current?.source === poll.source && this.ownsTranscriptPoll(paneKey, current)
        ? current
        : undefined
    }
    return withHookTranscriptPoll(
      this.state,
      paneKey,
      poll.source,
      () =>
        wanted() &&
        this.server === server &&
        this.statusHooksEnabled &&
        this.statusHookGeneration === generation &&
        Boolean(currentOwner()),
      (reads) => {
        const owner = currentOwner()
        if (owner) {
          this.applyTranscriptPoll(paneKey, owner, reads)
        }
      }
    )
  }

  // Recheck ownership at callback time; newer events supersede this payload even if children remain.
  private ownsTranscriptPoll(paneKey: string, { original }: TranscriptPoll): boolean {
    return (
      paneKey === original.paneKey &&
      this.server?.listening === true &&
      this.statusHooksEnabled &&
      this.state.lastStatusByPaneKey.get(original.paneKey) === original
    )
  }

  private applyTranscriptPoll(
    paneKey: string,
    poll: TranscriptPoll,
    reads: HookTranscriptPollReads | undefined
  ): void {
    const { source, body, original } = poll
    const logOffset = source === 'muse' ? museLogOffset(this.state, paneKey) : undefined
    const normalized = normalizeHookTranscriptPoll(this.state, poll, this.env, reads)
    if (!normalized) {
      return
    }
    // A poll's Stop is read from the hook body too, so a tmux host keeps its shared topology.
    retainTmuxHookWriterTopology(normalized, body)
    const update = transcriptPollUpdate(source, original, normalized)
    const next = update ? this.applyNormalizedStatus(update) : original
    if (next) {
      const quiet = !update && museLogOffset(this.state, paneKey) === logOffset
      const delayMs = nextHookTranscriptPollDelay(
        this.state,
        poll,
        paneKey,
        quiet,
        reads?.antigravity?.nextPoll
      )
      this.scheduleTranscriptPoll(source, body, next, delayMs)
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
