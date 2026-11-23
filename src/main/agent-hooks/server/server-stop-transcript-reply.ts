import { stat } from 'node:fs/promises'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { droidVerdictFields } from '../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { retainClaudeLeadModel } from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-roster-state'
import { claudeReplyModelChange } from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-transcript-reply-model'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  replyModelRead,
  replyRead,
  verdictRead,
  type StopTranscriptFind,
  type StopTranscriptRead
} from './server-stop-transcript-reads'
import { AgentHookServerStatusRetries } from './server-status-retries'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'

/** One Stop's pending transcript reads. Each retries on its own timer and publishes its find at
 *  once; any later hook that changes the row ends them all. */
type StopReplyClaim = {
  readonly paneKey: string
  readonly token: string
  readonly generation: number
  /** The Stop's row as last published; each read adds to it only while the pane still holds it. */
  row: EnrichedAgentHookEventPayload
  pendingReads: number
  readonly timers: Set<ReturnType<typeof setTimeout>>
  /** A statusline report since the Stop is newer than the reply's model. */
  replyModelSuperseded?: boolean
}

/** A Stop that came without its reply gets it from the transcript, and a Droid Stop its turn
 *  verdict, read off the event loop. */
export abstract class AgentHookServerStopTranscriptReply extends AgentHookServerStatusRetries {
  /** One per pane with a read in flight; any later hook that changes the row ends it. */
  private readonly stopReplyClaims = new Map<string, StopReplyClaim>()

  /** Whatever cancels a pending reply retry also ends the pane's pending reads. */
  protected override clearAssistantMessageRetry(paneKey: string): void {
    super.clearAssistantMessageRetry(paneKey)
    const claim = this.stopReplyClaims.get(paneKey)
    if (claim) {
      this.endStopReplyClaim(claim)
    }
  }

  /** Server stop or status hooks off: every pending reply retry and read ends. */
  protected clearAllAssistantMessageRetries(): void {
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    for (const claim of this.stopReplyClaims.values()) {
      this.endStopReplyClaim(claim)
    }
  }

  /** Applies a live hook, then reads the reply text it did not carry and a Droid Stop's verdict. */
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
    this.followStopReply(rowBefore, enriched, normalized)
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
      this.followStopReply(rowBefore, enriched, normalized)
    }
    return enriched
  }

  /** After every applied live hook: it ends the pane's pending reads, or starts them for its Stop. */
  protected followStopReply(
    rowBefore: AgentHookEventPayload | undefined,
    enriched: EnrichedAgentHookEventPayload,
    { stopTranscriptPath, droidVerdictTranscriptPath }: NormalizedLocalHook
  ): void {
    // A refused hook leaves the row it lost to: it neither ends that row's reads nor starts any.
    if (enriched === rowBefore) {
      return
    }
    const previousClaim = this.stopReplyClaims.get(enriched.paneKey)
    if (previousClaim) {
      this.endStopReplyClaim(previousClaim)
    }
    // A child's held permission card is not the lead's Stop row; restating it would drop the card.
    if (enriched.toolAgentId !== undefined) {
      return
    }
    const reads: [string, StopTranscriptRead][] = []
    if (stopTranscriptPath) {
      const format = enriched.payload.agentType === 'copilot' ? 'copilot' : 'shared'
      reads.push([stopTranscriptPath, replyRead(stopTranscriptPath, format)])
    }
    if (droidVerdictTranscriptPath) {
      reads.push([droidVerdictTranscriptPath, verdictRead(droidVerdictTranscriptPath)])
    }
    // Claude hooks name the model only at SessionStart; each Stop's reply names the one /model set.
    const replyModelPath =
      enriched.payload.agentType === 'claude' && enriched.hookEventName === 'Stop'
        ? enriched.providerSession?.transcriptPath
        : undefined
    if (replyModelPath) {
      reads.push([replyModelPath, replyModelRead(replyModelPath)])
    }
    if (reads.length === 0) {
      return
    }
    const claim: StopReplyClaim = {
      paneKey: enriched.paneKey,
      token: this.token,
      generation: this.statusHookGeneration,
      row: enriched,
      pendingReads: reads.length,
      timers: new Set()
    }
    this.stopReplyClaims.set(enriched.paneKey, claim)
    // A slow or stalled read never holds back the other's find.
    for (const [transcriptPath, read] of reads) {
      this.readStopTranscript(claim, transcriptPath, read)
    }
  }

  /** Claude's statusline names the live model, even an unchanged one, so it wins over a pending
   *  Stop read of the model that wrote the reply. */
  protected supersedeStopReplyModel(paneKey: string): void {
    const claim = this.stopReplyClaims.get(paneKey)
    if (claim) {
      claim.replyModelSuperseded = true
    }
  }

  private endStopReplyClaim(claim: StopReplyClaim): void {
    for (const timer of claim.timers) {
      clearTimeout(timer)
    }
    claim.timers.clear()
    if (this.stopReplyClaims.get(claim.paneKey) === claim) {
      this.stopReplyClaims.delete(claim.paneKey)
    }
  }

  /** The pane's row while it is still this claim's Stop. The claim ends with any later hook, even
   *  one in the same millisecond; the receipt check rejects rows Orca rebuilt meanwhile (a pane
   *  sleeping, an exited agent's resume row) while an identity settling keeps it. */
  private currentStopRow(claim: StopReplyClaim): AgentHookEventPayload | undefined {
    const row = this.state.lastStatusByPaneKey.get(claim.paneKey)
    const stop = claim.row
    return this.statusHooksEnabled &&
      this.token === claim.token &&
      this.statusHookGeneration === claim.generation &&
      this.stopReplyClaims.get(claim.paneKey) === claim &&
      row &&
      !('paneSleep' in row && row.paneSleep) &&
      !('providerSessionOnly' in row && row.providerSessionOnly) &&
      'receivedAt' in row &&
      row.receivedAt === stop.receivedAt &&
      'stateStartedAt' in row &&
      row.stateStartedAt === stop.stateStartedAt &&
      row.payload.state === stop.payload.state &&
      row.payload.prompt === stop.payload.prompt
      ? row
      : undefined
  }

  /** The Stop already applied in hook order; one read off the event loop retries on its own budget
   *  until it finds what it reads, then adds that to the Stop's row. */
  private readStopTranscript(
    claim: StopReplyClaim,
    transcriptPath: string,
    read: StopTranscriptRead,
    attempt = 1,
    progress: { scannedSize?: number } = {}
  ): void {
    const scan = async (): Promise<StopTranscriptFind | undefined> => {
      const size = await stat(transcriptPath).then(
        (stats) => stats.size,
        () => undefined
      )
      // A retry reads only lines reaching past its last scan's size, and nothing if the file hasn't grown.
      const previous = progress.scannedSize
      if (size !== undefined && size === previous) {
        return undefined
      }
      progress.scannedSize = size
      return read.scan(
        () => this.currentStopRow(claim) !== undefined,
        size !== undefined && previous !== undefined && size > previous ? previous : undefined,
        // A failed read saw nothing; the next retry reads in full even at the same size.
        () => {
          progress.scannedSize = undefined
        }
      )
    }
    void scan().then((found) => {
      const row = this.currentStopRow(claim)
      if (!row) {
        this.endStopReplyClaim(claim)
        return
      }
      const delay = found ? undefined : read.retryDelayMs(attempt)
      if (delay !== undefined) {
        // Stop can precede the transcript flush.
        const timer = setTimeout(() => {
          claim.timers.delete(timer)
          this.readStopTranscript(claim, transcriptPath, read, attempt + 1, progress)
        }, delay)
        timer.unref?.()
        claim.timers.add(timer)
        return
      }
      if (found) {
        this.restateStopRow(claim, row, found)
      }
      claim.pendingReads -= 1
      if (claim.pendingReads === 0) {
        this.endStopReplyClaim(claim)
      }
    })
  }

  private restateStopRow(
    claim: StopReplyClaim,
    row: AgentHookEventPayload,
    { text, verdict, model }: StopTranscriptFind
  ): void {
    const newModel =
      model && !claim.replyModelSuperseded
        ? claudeReplyModelChange(row.payload.model, model)
        : undefined
    if (!text && !verdict && !newModel) {
      return
    }
    const payload = normalizeAgentStatusPayload({
      ...row.payload,
      ...(newModel ? { model: newModel } : {}),
      ...(text ? { lastAssistantMessage: text, lastAssistantMessageIsToolOutput: undefined } : {}),
      ...(verdict ? droidVerdictFields(verdict, claim.row.stateStartedAt) : {})
    })
    if (!payload) {
      return
    }
    const tool = text ? this.state.lastToolByPaneKey.get(claim.paneKey) : undefined
    if (tool) {
      // Later rebuilds of this turn's row read the snapshot, not the row.
      this.state.lastToolByPaneKey.set(claim.paneKey, {
        ...tool,
        lastAssistantMessage: payload.lastAssistantMessage,
        lastAssistantMessageIsToolOutput: undefined
      })
    }
    // The restate is this Stop's own row change: it must not end the Stop's other read.
    this.stopReplyClaims.delete(claim.paneKey)
    const restated = this.applyRestatedStatus({
      ...row,
      payload,
      // The whole reply answers the lead's turn; the row keeps only its capped preview.
      ...(text ? { replyCandidate: text } : {}),
      hookEventName: undefined,
      hasExplicitPrompt: undefined
    })
    if (restated && newModel) {
      // Later lead events rebuild the row from this record.
      retainClaudeLeadModel(this.state, claim.paneKey, newModel)
    }
    claim.row = restated ?? claim.row
    this.stopReplyClaims.set(claim.paneKey, claim)
  }
}
