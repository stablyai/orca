import { stat } from 'node:fs/promises'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { readLastAssistantFromTranscriptAsync } from '../../../shared/agent-hook-listener/transcript-reader'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import { ASSISTANT_MESSAGE_RETRY_ATTEMPTS, ASSISTANT_MESSAGE_RETRY_MS } from './server-constants'
import { AgentHookServerStatusRetries } from './server-status-retries'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'

/** The identity of one Stop's pending reply read, and the transcript size its last scan saw. */
type StopReplyClaim = { readonly paneKey: string; scannedSize?: number }

/** A Stop that came without its reply gets it from the transcript, read off the event loop. */
export abstract class AgentHookServerStopTranscriptReply extends AgentHookServerStatusRetries {
  /** One per pane with a read in flight; any later hook that changes the row ends it. */
  private readonly stopReplyClaims = new Map<string, StopReplyClaim>()

  /** Whatever cancels a pending reply retry also ends the pane's pending read. */
  protected override clearAssistantMessageRetry(paneKey: string): void {
    super.clearAssistantMessageRetry(paneKey)
    this.stopReplyClaims.delete(paneKey)
  }

  /** Server stop or status hooks off: every pending reply retry and read ends. */
  protected clearAllAssistantMessageRetries(): void {
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    this.stopReplyClaims.clear()
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
    // A refused hook must not retry onto, or end the read of, the row it lost to.
    if (enriched !== rowBefore && !normalized.stopTranscriptPath) {
      this.scheduleAssistantMessageRetry(source, body, enriched)
    }
    this.followStopReply(rowBefore, enriched, normalized.stopTranscriptPath)
    return enriched
  }

  /** Spool replay applies with its recorded receipt, then follows up on a Stop's reply the same way. */
  protected applyReplayedHookAndReply(
    event: AgentHookEventPayload,
    normalized: NormalizedLocalHook,
    receivedAt: number
  ): EnrichedAgentHookEventPayload | undefined {
    const rowBefore = this.state.lastStatusByPaneKey.get(event.paneKey)
    const enriched = this.applyObservedLocalHook(event, normalized.onAccepted, receivedAt)
    if (enriched) {
      this.followStopReply(rowBefore, enriched, normalized.stopTranscriptPath)
    }
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
      const claim: StopReplyClaim = { paneKey: enriched.paneKey }
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
    claim: StopReplyClaim,
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
    const scan = async (): Promise<string | undefined> => {
      const size = await stat(transcriptPath).then(
        (stats) => stats.size,
        () => undefined
      )
      // A retry reads only lines reaching past its last scan's size, and nothing if the file hasn't grown.
      const previous = claim.scannedSize
      if (size !== undefined && size === previous) {
        return undefined
      }
      claim.scannedSize = size
      return readLastAssistantFromTranscriptAsync(
        transcriptPath,
        () => current() !== undefined,
        size !== undefined && previous !== undefined && size > previous ? previous : undefined,
        // A failed read saw nothing; the next retry reads in full even at the same size.
        () => {
          claim.scannedSize = undefined
        }
      )
    }
    void scan().then((text) => {
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
    })
  }
}
