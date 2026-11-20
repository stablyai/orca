import { stat } from 'node:fs/promises'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  droidVerdictFields,
  readDroidTurnVerdictAsync,
  type DroidTurnVerdict
} from '../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome'
import { readLastAssistantFromTranscriptAsync } from '../../../shared/agent-hook-listener/transcript-reader'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import { ASSISTANT_MESSAGE_RETRY_ATTEMPTS, ASSISTANT_MESSAGE_RETRY_MS } from './server-constants'
import { AgentHookServerStatusRetries } from './server-status-retries'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'

/** The identity of one Stop's pending reply read, the transcript size its last scan saw, and what
 *  it found so far: a Droid Stop also waits for the turn verdict Droid appends after it. */
type StopReplyClaim = {
  readonly paneKey: string
  scannedSize?: number
  text?: string
  textApplied?: boolean
  verdict?: DroidTurnVerdict | null
}

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
    const awaitsVerdict = original.payload.agentType === 'droid'
    const scan = async (): Promise<void> => {
      const size = await stat(transcriptPath).then(
        (stats) => stats.size,
        () => undefined
      )
      // A retry reads only lines reaching past its last scan's size, and nothing if the file hasn't grown.
      const previous = claim.scannedSize
      if (size !== undefined && size === previous) {
        return
      }
      claim.scannedSize = size
      const keepReading = () => current() !== undefined
      claim.text ??= await readLastAssistantFromTranscriptAsync(
        transcriptPath,
        keepReading,
        size !== undefined && previous !== undefined && size > previous ? previous : undefined,
        // A failed read saw nothing; the next retry reads in full even at the same size.
        () => {
          claim.scannedSize = undefined
        }
      )
      if (awaitsVerdict && claim.verdict === undefined) {
        claim.verdict = await readDroidTurnVerdictAsync(transcriptPath, keepReading, () => {
          claim.scannedSize = undefined
        })
      }
    }
    void scan().then(() => {
      const row = current()
      const { text, verdict } = claim
      // The reply lands as soon as it is read; a Droid verdict read after it restates the same row.
      const restated =
        row && ((text && !claim.textApplied) || verdict)
          ? this.restateStopRow(original, row, claim.textApplied ? undefined : text, verdict)
          : undefined
      claim.textApplied ||= text !== undefined
      // Droid writes its verdict last, so once it is read no reply text can follow.
      const pending = awaitsVerdict ? verdict === undefined : !text
      if (row && pending && attempt < ASSISTANT_MESSAGE_RETRY_ATTEMPTS) {
        // The text restate ends the claim like any row change; this Stop's verdict read goes on
        // against the restated row.
        this.stopReplyClaims.set(original.paneKey, claim)
        // Stop can precede the transcript flush.
        super.clearAssistantMessageRetry(original.paneKey)
        const timer = setTimeout(() => {
          this.assistantMessageRetryTimers.delete(original.paneKey)
          this.readStopTextFromTranscript(restated ?? original, transcriptPath, claim, attempt + 1)
        }, ASSISTANT_MESSAGE_RETRY_MS)
        timer.unref?.()
        this.assistantMessageRetryTimers.set(original.paneKey, timer)
        return
      }
      if (this.stopReplyClaims.get(original.paneKey) === claim) {
        this.stopReplyClaims.delete(original.paneKey)
      }
    })
  }

  private restateStopRow(
    original: EnrichedAgentHookEventPayload,
    row: AgentHookEventPayload,
    text: string | undefined,
    verdict: DroidTurnVerdict | null | undefined
  ): EnrichedAgentHookEventPayload | undefined {
    const payload = normalizeAgentStatusPayload({
      ...row.payload,
      ...(text ? { lastAssistantMessage: text, lastAssistantMessageIsToolOutput: undefined } : {}),
      ...(verdict ? droidVerdictFields(verdict, original.stateStartedAt) : {})
    })
    if (!payload) {
      return undefined
    }
    const tool = text ? this.state.lastToolByPaneKey.get(original.paneKey) : undefined
    if (tool) {
      // Later rebuilds of this turn's row read the snapshot, not the row.
      this.state.lastToolByPaneKey.set(original.paneKey, {
        ...tool,
        lastAssistantMessage: payload.lastAssistantMessage,
        lastAssistantMessageIsToolOutput: undefined
      })
    }
    return this.applyRestatedStatus({
      ...row,
      payload,
      // The whole reply answers the lead's turn; the row keeps only its capped preview.
      ...(text ? { replyCandidate: text } : {}),
      hookEventName: undefined,
      hasExplicitPrompt: undefined
    })
  }
}
