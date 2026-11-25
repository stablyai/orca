import { ClaudeHelperKillPoller } from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-helper-kill-poller'
import { retainTmuxHookWriterTopology } from './cli-writer-observation'
import {
  pollCodexTranscriptStatus,
  readCodexTranscriptPoll,
  type CodexTranscriptPollReads
} from '../../../shared/agent-hook-listener/providers/codex/codex-transcript-poll'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { pickHostTurnEnd } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  museHookPollPane,
  museLogOffset,
  nextMusePollDelay,
  shouldPollHookTranscript,
  hookTranscriptWatchPath,
  transcriptPollUpdate
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import { AgentTranscriptPollScheduler } from '../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'
import type { EnrichedAgentHookEventPayload, IncomingAgentHookEvent } from './server-types'
import { codexReplayLeftTranscriptWork } from '../../../shared/agent-hook-listener/providers/codex/codex-state'
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
    (paneKey, poll) => this.runTranscriptPoll(paneKey, poll)
  )

  protected readonly replayTranscriptPolls = new Map<
    string,
    { body: unknown; original: EnrichedAgentHookEventPayload }
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

  /** Replay drains before the server binds, and a poll that runs then is dropped, so these wait for it to listen. */
  protected requestReplayTranscriptPoll(
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    if (!codexReplayLeftTranscriptWork(this.state, original.paneKey)) {
      return
    }
    if (this.server) {
      this.scheduleTranscriptPoll('codex', body, original)
    } else {
      this.replayTranscriptPolls.set(original.paneKey, { body, original })
    }
  }

  protected scheduleReplayTranscriptPolls(): void {
    for (const { body, original } of this.replayTranscriptPolls.values()) {
      this.scheduleTranscriptPoll('codex', body, original)
    }
    this.replayTranscriptPolls.clear()
  }

  protected scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    delayMs?: number
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
    // Codex keeps the scheduler's cadence; a Muse poll without a delay is a fresh hook's 1s poll.
    const museDelayMs = source === 'muse' ? (delayMs ?? nextMusePollDelay()) : undefined
    this.transcriptPollScheduler.schedule(
      original.paneKey,
      { source, body, original, delayMs: museDelayMs },
      hookTranscriptWatchPath(this.state, source, original.paneKey),
      museDelayMs
    )
  }

  protected rearmIgnoredMuseHook(body: unknown): void {
    const paneKey = museHookPollPane(this.state, body, this.env)
    if (!paneKey) {
      return
    }
    const poll = this.transcriptPollScheduler.peek(paneKey)
    if (poll?.source === 'muse' && this.state.lastStatusByPaneKey.get(paneKey) === poll.original) {
      this.scheduleTranscriptPoll('muse', poll.body, poll.original)
    }
  }

  private runTranscriptPoll(paneKey: string, poll: TranscriptPoll): void | Promise<void> {
    if (!this.ownsTranscriptPoll(paneKey, poll)) {
      return
    }
    if (poll.source !== 'codex') {
      this.applyTranscriptPoll(paneKey, poll, undefined)
      return
    }
    // Why: rollout reads stay off the main thread (#43539); the next tick waits for this one.
    return readCodexTranscriptPoll(this.state, paneKey).then((reads) => {
      // A hook that replaced the row mid-read owns the pane's poll now; its reads still apply.
      const current = this.transcriptPollScheduler.peek(paneKey)
      const owner = this.ownsTranscriptPoll(paneKey, poll)
        ? poll
        : current?.source === 'codex' && this.ownsTranscriptPoll(paneKey, current)
          ? current
          : undefined
      try {
        if (owner) {
          this.applyTranscriptPoll(paneKey, owner, reads)
        }
      } finally {
        reads.batch.release()
      }
    })
  }

  // Recheck ownership at callback time; newer events supersede this payload even if children remain.
  private ownsTranscriptPoll(paneKey: string, { original }: TranscriptPoll): boolean {
    return (
      paneKey === original.paneKey &&
      Boolean(this.server) &&
      this.state.lastStatusByPaneKey.get(original.paneKey) === original
    )
  }

  private applyTranscriptPoll(
    paneKey: string,
    poll: TranscriptPoll,
    codexReads: CodexTranscriptPollReads | undefined
  ): void {
    const { source, body, original } = poll
    const logOffset = source === 'muse' ? museLogOffset(this.state, paneKey) : undefined
    const normalized = codexReads
      ? pollCodexTranscriptStatus(this.state, original, body, this.env, codexReads)
      : normalizeHookPayload(this.state, source, body, this.env)
    if (!normalized) {
      return
    }
    // A poll's Stop is read from the hook body too, so a tmux host keeps its shared topology.
    retainTmuxHookWriterTopology(normalized, body)
    const update = transcriptPollUpdate(source, original, normalized)
    const next = update ? this.applyNormalizedStatus(update) : original
    if (next) {
      const quiet = !update && museLogOffset(this.state, paneKey) === logOffset
      const delayMs = source === 'muse' ? nextMusePollDelay(poll.delayMs, quiet) : undefined
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
