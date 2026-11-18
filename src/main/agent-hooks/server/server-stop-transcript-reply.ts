import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { readLastAssistantFromTranscriptAsync } from '../../../shared/agent-hook-listener/transcript-reader'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import { ASSISTANT_MESSAGE_RETRY_ATTEMPTS, ASSISTANT_MESSAGE_RETRY_MS } from './server-constants'
import { AgentHookServerStatusRetries } from './server-status-retries'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'

/** A Stop that came without its reply gets it from the transcript, read off the event loop. */
export abstract class AgentHookServerStopTranscriptReply extends AgentHookServerStatusRetries {
  /** One per pane with a read in flight; any later hook that changes the row ends it. */
  private readonly stopReplyClaims = new Map<string, object>()

  /** Whatever cancels a pending reply retry also ends the pane's pending read. */
  protected override clearAssistantMessageRetry(paneKey: string): void {
    super.clearAssistantMessageRetry(paneKey)
    this.stopReplyClaims.delete(paneKey)
  }

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
    }
    this.followStopReply(rowBefore, enriched, normalized.stopTranscriptPath)
    return enriched
  }

  /** After every applied live hook: it ends the pane's pending read, or starts one for its Stop. */
  protected followStopReply(
    rowBefore: AgentHookEventPayload | undefined,
    enriched: EnrichedAgentHookEventPayload,
    transcriptPath: string | undefined
  ): void {
    // A refused hook leaves the row it lost to: it neither ends that row's read nor starts one.
    if (enriched === rowBefore) {
      return
    }
    this.stopReplyClaims.delete(enriched.paneKey)
    // A child's held permission card is not the lead's Stop row; restating it would drop the card.
    if (transcriptPath && enriched.toolAgentId === undefined) {
      const claim = {}
      this.stopReplyClaims.set(enriched.paneKey, claim)
      this.readStopTextFromTranscript(enriched, transcriptPath, claim)
    }
  }

  /**
   * The Stop already applied in hook order without its text; read it off the event loop and add
   * it to that Stop's row. The claim ends with any later hook, even one in the same millisecond;
   * the receipt check rejects rows Orca rebuilt meanwhile (a pane sleeping, an exited agent's
   * resume row) while an identity settling keeps it.
   */
  private readStopTextFromTranscript(
    original: EnrichedAgentHookEventPayload,
    transcriptPath: string,
    claim: object,
    attempt = 1
  ): void {
    const token = this.token
    const generation = this.statusHookGeneration
    const current = (): AgentHookEventPayload | undefined => {
      const row = this.state.lastStatusByPaneKey.get(original.paneKey)
      return this.statusHooksEnabled &&
        this.token === token &&
        this.statusHookGeneration === generation &&
        this.stopReplyClaims.get(original.paneKey) === claim &&
        row &&
        !('paneSleep' in row && row.paneSleep) &&
        !('providerSessionOnly' in row && row.providerSessionOnly) &&
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
        if (!row || (!text && attempt >= ASSISTANT_MESSAGE_RETRY_ATTEMPTS)) {
          if (this.stopReplyClaims.get(original.paneKey) === claim) {
            this.stopReplyClaims.delete(original.paneKey)
          }
          return
        }
        if (!text) {
          // Stop can precede the transcript flush.
          super.clearAssistantMessageRetry(original.paneKey)
          const timer = setTimeout(() => {
            this.assistantMessageRetryTimers.delete(original.paneKey)
            this.readStopTextFromTranscript(original, transcriptPath, claim, attempt + 1)
          }, ASSISTANT_MESSAGE_RETRY_MS)
          timer.unref?.()
          this.assistantMessageRetryTimers.set(original.paneKey, timer)
          return
        }
        this.stopReplyClaims.delete(original.paneKey)
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
