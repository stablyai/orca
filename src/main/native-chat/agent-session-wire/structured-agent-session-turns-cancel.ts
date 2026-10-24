import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalStatusItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import {
  isStructuredAgentSessionCommandTurnId,
  structuredAgentSessionCommandWasStopped,
  structuredAgentSessionStopNoteIdentity
} from './structured-agent-session-command-turn'
import {
  answerCancelOfSettledPrompt,
  validatePendingPrompt
} from './structured-agent-session-prompt-state'
import {
  STOP_NOTE_CANCELLATION_REQUESTED,
  structuredAgentSessionNamedTurnScope,
  structuredAgentSessionStopNamesTurnNotLive,
  structuredAgentSessionStoppedTurnId
} from './structured-agent-session-turn-stop-notes'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionStopWindDown } from './structured-agent-session-stop-wind-down'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'
import { structuredAgentSessionFailedStopMark } from './structured-agent-session-stopping'
import { sendStopCanTakeBack } from './structured-agent-session-unopened-send-withdrawal'
import { settleTakenStop } from './structured-agent-session-taken-stop-settle'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Writes fold before returning, so Stop reads current work without waiting on the write queue. */
export function isMainAgentWorking(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork'>
): boolean {
  return contextStructuredAgentSessionCurrentWork(ctx).working()
}

/** Never kill a different turn; child exit reads at rest even while its cleanup waits behind Stop. */
function stillRunsStoppedTurn(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork'>,
  stoppedTurnId: string | null
): boolean {
  const work = contextStructuredAgentSessionCurrentWork(ctx)
  if (!work.working()) {
    return false
  }
  // Working without an open turn after the captured turn means a later send.
  return stoppedTurnId === null || work.activeTurnId() === stoppedTurnId
}

function tookBackEverySend(
  ctx: Pick<AgentSessionTurnContext, 'journal'>,
  inFlight: readonly AgentJournalSubmission[]
): boolean {
  const rejected = new Set(
    ctx.journal
      .submissions()
      .flatMap((entry) => (entry.dispatchState === 'rejected' ? [entry.clientMessageId] : []))
  )
  return inFlight.length > 0 && inFlight.every((entry) => rejected.has(entry.clientMessageId))
}

/** A refusal that may still open a turn is unconfirmed, never proof that nothing ran. */
function stopRefusedNote(
  ctx: Pick<AgentSessionTurnContext, 'failureTextContext'>,
  refusal: AgentSessionCancelOutcome['refusal']
): AgentJournalStatusItem {
  const detail = refusal?.detail
  const fact = refusal?.turnMayOpen
    ? agentSessionFailureFact('cancelUnconfirmed')
    : agentSessionFailureFact('stopRefused', detail ? { detail } : {})
  return {
    kind: 'status',
    ...agentSessionFailureWords(fact, { ...ctx.failureTextContext, surface: 'row' })
  }
}

type StopSettleBinding = {
  turnId?: string
  failedOn?: JournalStopFailedOn
  closedByWindDown?: true
}

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: PerformCancelInput
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  if (input.prompt) {
    const validated = validatePendingPrompt(ctx, input.prompt)
    if (!validated.ok) {
      return answerCancelOfSettledPrompt(ctx, { ...input, prompt: input.prompt }, validated)
    }
  }
  // Turnless Stop binds work ending during its settlement.
  const settle = input.opensSettle ? ctx.journal.stopMarks.beginSettle() : null
  const binding: StopSettleBinding = {}
  const close = (failedOn?: JournalStopFailedOn): void =>
    ctx.journal.stopMarks.settled(settle, binding.turnId, binding.failedOn ?? failedOn)
  try {
    return await cancelAndNote(ctx, input, binding, close)
  } finally {
    if (!binding.closedByWindDown) {
      close()
    }
  }
}

type PerformCancelInput = {
  clientOperationId: string
  /** Absent targets all in-flight work; present targets only this current turn. */
  turnId?: string
  prompt?: { itemId: string; expectedRevision: number }
  /** End the child when a command/turn cannot be interrupted. */
  stopChild?: () => Promise<void>
  onStopChildError?: (error: unknown) => void
  /** Exit may be proven even when later cleanup throws. */
  childReleased?: () => boolean
  /** Defer session-ending Stop to the next serialized step. */
  endSession?: (windDown: StructuredAgentSessionStopWindDown) => void
  /** Await only after interrupting. */
  withdrewQueued?: Promise<boolean>
  /** This press owns or repeats the latest Stop event, whose settlement binds. */
  opensSettle?: true
  /** Stop-triggered child exit may advance the fence beyond ctx.fence. */
  noteFence?: () => number
}

async function cancelAndNote(
  ctx: AgentSessionTurnContext,
  input: PerformCancelInput,
  binding: StopSettleBinding,
  closeSettle: (failedOn?: JournalStopFailedOn) => void
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  let cancelled = false
  let note: AgentJournalStatusItem | null = {
    kind: 'status',
    text: STOP_NOTE_CANCELLATION_REQUESTED
  }
  // Target current work only; an ended generation’s turn remains ineligible before cleanup lands.
  const work = () => contextStructuredAgentSessionCurrentWork(ctx)
  // Capture the note’s turn before cancel can settle it.
  const turnScope =
    (input.turnId !== undefined
      ? structuredAgentSessionNamedTurnScope(ctx.journal, input.turnId)
      : null) ?? work().turnScope()
  // Commands end only through provider or child exit; dead-generation settlement supplies their verdict.
  const liveTurnId = work().activeTurnId()
  const stoppedTurnId = structuredAgentSessionStoppedTurnId(work(), input.turnId)
  const namesTurnNotLive = structuredAgentSessionStopNamesTurnNotLive(input.turnId, liveTurnId)
  const runningCommand =
    input.stopChild !== undefined &&
    liveTurnId !== null &&
    isStructuredAgentSessionCommandTurnId(liveTurnId) &&
    !namesTurnNotLive
  const stoppedBefore =
    runningCommand && structuredAgentSessionCommandWasStopped(ctx.journal, liveTurnId)
  // Capture before session-ending Stop discards the child.
  const endsSession =
    input.endSession !== undefined && ctx.adapter.stopEndsSession?.(ctx.sessionId) === true
  const stoppedAt = Date.now()
  // Capture sends before cancel can settle them.
  const sentBeforeStop = ctx.journal.submissions().filter(sendStopCanTakeBack)
  // undefined means cancel threw and its effect is unknown.
  let taken: boolean | undefined
  let interruptFailed = false
  let refusal: AgentSessionCancelOutcome['refusal']
  let stoppedTurn: string | undefined
  try {
    const dispatchStatus = latestJournalDispatchObservation(ctx.journal, ctx.fence)
    const outcome: AgentSessionCancelOutcome = stoppedBefore
      ? { cancelled: false }
      : await ctx.adapter.cancelTurn({
          sessionId: ctx.sessionId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          fence: ctx.fence,
          // Validate against the journal the client used to name its turn.
          resolveLiveTurnId: () => work().activeTurnId(),
          ...(dispatchStatus ? { dispatchStatus } : {}),
          ...(input.prompt ? { prompt: { itemId: input.prompt.itemId } } : {})
        })
    taken = outcome.cancelled
    cancelled = outcome.cancelled
    refusal = outcome.refusal
    stoppedTurn = outcome.turnId
    interruptFailed = refusal !== undefined && refusal.turnNotRunning !== true
    // Check work first: a live turn must never wait on queued-message withdrawal.
    if (!cancelled && !isMainAgentWorking(ctx) && (await input.withdrewQueued) === true) {
      // Withdrawing all queued work confirms Stop regardless of provider no-op wording.
      cancelled = true
      note = null
    } else if (!cancelled && input.prompt) {
      note = null
    } else if (!cancelled && input.turnId === undefined) {
      note = stopRefusedNote(ctx, refusal)
    }
  } catch (error) {
    if (input.prompt) {
      throw error
    }
    interruptFailed = true
    note = {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
    }
  }
  const noteIdentity = structuredAgentSessionStopNoteIdentity(
    stoppedTurn ?? stoppedTurnId ?? input.clientOperationId
  )
  // Declined old-turn Stops retain the session; any other interrupt may affect a follow-up before it opens.
  if (endsSession && (!namesTurnNotLive || taken !== false)) {
    // Accepted interrupts warrant wind-down even before their turn echo arrives.
    binding.closedByWindDown = true
    input.endSession?.({
      waitsForProvider: taken === true,
      stoppedAt,
      stopNote: noteIdentity,
      settled: closeSettle
    })
    cancelled = true
    // Child exit confirms Stop, superseding interrupt uncertainty.
    if (note !== null) {
      note = { kind: 'status', text: 'Cancellation requested.' }
    }
  } else if (runningCommand && !cancelled) {
    await input.stopChild?.()
    cancelled = true
    note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
  } else if (
    !cancelled &&
    interruptFailed &&
    input.stopChild &&
    stillRunsStoppedTurn(ctx, stoppedTurnId)
  ) {
    let ended: boolean
    try {
      await input.stopChild()
      ended = true
    } catch (error) {
      input.onStopChildError?.(error)
      // A cleanup error confirms exit only if the host already released the child.
      ended = input.childReleased?.() === true
    }
    if (ended) {
      cancelled = true
      // Withdrawn sends render their own feedback; another notice misattributes the previous turn on old clients.
      note =
        stoppedTurnId === null && tookBackEverySend(ctx, sentBeforeStop)
          ? null
          : { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    } else if (taken !== undefined) {
      note = stopRefusedNote(ctx, refusal)
    }
  } else if (!cancelled && taken === false && input.turnId !== undefined) {
    note = null
  }
  if (cancelled) {
    binding.turnId = stoppedTurn ?? stoppedTurnId ?? undefined
  } else if (interruptFailed) {
    // Failed Stop keeps Stopping on the affected turn without owning that turn’s eventual end.
    binding.failedOn = structuredAgentSessionFailedStopMark(work(), ctx.journal)
  }
  if (taken === true && stoppedTurn !== undefined && !binding.closedByWindDown) {
    const opened = await settleTakenStop(ctx, stoppedTurn)
    if (!opened && stoppedTurnId === null && tookBackEverySend(ctx, sentBeforeStop)) {
      note = null
    }
  }
  const value = { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled }
  if (note === null) {
    return { ok: true, value }
  }
  // Prefer the provider’s turn opened during cancel over the scope captured before waiting.
  const noteScope =
    (stoppedTurn !== undefined
      ? structuredAgentSessionNamedTurnScope(ctx.journal, stoppedTurn)
      : null) ?? turnScope
  // Best-effort notes cannot change the accepted Stop.
  const fence = Math.max(ctx.fence, input.noteFence?.() ?? ctx.fence)
  await ctx.journal
    .appendItem(noteIdentity, note, { fence, turnScope: noteScope })
    .catch((error: unknown) =>
      ctx.logger.warn("writing a Stop's note failed", {
        scope: 'stop-note',
        sessionId: ctx.sessionId,
        error
      })
    )
  return { ok: true, value }
}
