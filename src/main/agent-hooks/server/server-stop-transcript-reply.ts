import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { readLastAssistantFromTranscriptAsync } from '../../../shared/agent-hook-listener/transcript-reader'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import { ASSISTANT_MESSAGE_RETRY_ATTEMPTS, ASSISTANT_MESSAGE_RETRY_MS } from './server-constants'
import { AgentHookServerStatusRetries } from './server-status-retries'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'

/** A Stop that came without its reply gets it from the transcript, read off the event loop. */
export abstract class AgentHookServerStopTranscriptReply extends AgentHookServerStatusRetries {
  /** Applies a live hook, then follows up on the reply text it did not carry. */
  protected applyLocalHookAndReply(
    source: AgentHookSource,
    body: unknown,
    event: AgentHookEventPayload,
    normalized: NormalizedLocalHook
  ): EnrichedAgentHookEventPayload | undefined {
    const rowBefore = this.state.lastStatusByPaneKey.get(event.paneKey)
    const enriched = this.applyObservedLocalHook(event, normalized.onAccepted)
    if (!enriched) {
      return undefined
    }
    if (!normalized.stopTranscriptPath) {
      this.scheduleAssistantMessageRetry(source, body, enriched)
    } else if (enriched !== rowBefore) {
      // A refused Stop leaves the row it lost to; its transcript's reply must not land there.
      this.readStopTextFromTranscript(enriched, normalized.stopTranscriptPath)
    }
    return enriched
  }

  /**
   * The Stop already applied in hook order without its text; read it off the event loop and add
   * it to that Stop's row. The row's hook receipt pins the turn: any later hook, even a re-asked
   * identical prompt, stamps a new one and wins; restatements of the same row (an identity
   * settling) keep it.
   */
  protected readStopTextFromTranscript(
    original: EnrichedAgentHookEventPayload,
    transcriptPath: string,
    attempt = 1
  ): void {
    const token = this.token
    const generation = this.statusHookGeneration
    const current = (): AgentHookEventPayload | undefined => {
      const row = this.state.lastStatusByPaneKey.get(original.paneKey)
      return this.statusHooksEnabled &&
        this.token === token &&
        this.statusHookGeneration === generation &&
        row &&
        'receivedAt' in row &&
        row.receivedAt === original.receivedAt &&
        'stateStartedAt' in row &&
        row.stateStartedAt === original.stateStartedAt &&
        row.payload.state === original.payload.state &&
        row.payload.prompt === original.payload.prompt
        ? row
        : undefined
    }
    void readLastAssistantFromTranscriptAsync(transcriptPath, () => current() !== undefined).then(
      (text) => {
        const row = current()
        if (!row) {
          return
        }
        if (!text) {
          // Stop can precede the transcript flush.
          if (attempt < ASSISTANT_MESSAGE_RETRY_ATTEMPTS) {
            this.clearAssistantMessageRetry(original.paneKey)
            const timer = setTimeout(() => {
              this.assistantMessageRetryTimers.delete(original.paneKey)
              this.readStopTextFromTranscript(original, transcriptPath, attempt + 1)
            }, ASSISTANT_MESSAGE_RETRY_MS)
            timer.unref?.()
            this.assistantMessageRetryTimers.set(original.paneKey, timer)
          }
          return
        }
        const payload = normalizeAgentStatusPayload({
          ...row.payload,
          lastAssistantMessage: text,
          lastAssistantMessageIsToolOutput: undefined
        })
        if (!payload) {
          return
        }
        const tool = this.state.lastToolByPaneKey.get(original.paneKey)
        if (tool) {
          // Later rebuilds of this turn's row read the snapshot, not the row.
          this.state.lastToolByPaneKey.set(original.paneKey, {
            ...tool,
            lastAssistantMessage: payload.lastAssistantMessage,
            lastAssistantMessageIsToolOutput: undefined
          })
        }
        this.applyRestatedStatus({
          ...row,
          payload,
          // The whole reply answers the lead's turn; the row keeps only its capped preview.
          replyCandidate: text,
          hookEventName: undefined,
          hasExplicitPrompt: undefined
        })
      }
    )
  }
}
