import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalStatusItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'
import type { AgentSessionStopOutcome } from './structured-agent-session-adapter-stop'
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
  structuredAgentSessionStoppedTurnId,
  writeStructuredAgentSessionStopNote
} from './structured-agent-session-turn-stop-notes'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionStopWindDown } from './structured-agent-session-stop-wind-down'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'
import { structuredAgentSessionFailedStopMark } from './structured-agent-session-stopping'
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
  // An accepted chat Stop owns every turn its captured child ends, whatever its event names.
  const settle = input.opensSettle
    ? ctx.journal.stopMarks.beginSettle(Boolean(input.acceptedStop && input.endSession))
    : null
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

/** A chat Stop's accepted target and request feedback survive later dispatch settlement. */
export type AcceptedChatStop = {
  turnId: string | null
  turnScope: AgentJournalTurnScope
  previouslyStopped: boolean
  requestNoteWrite?: Promise<void>
}

type PerformCancelInput = {
  clientOperationId: string
  /** Absent targets all in-flight work; present targets only this current turn. */
  turnId?: string
  acceptedStop?: AcceptedChatStop
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
    input.acceptedStop?.turnScope ??
    (input.turnId !== undefined
      ? structuredAgentSessionNamedTurnScope(ctx.journal, input.turnId)
      : null) ??
    work().turnScope()
  // Commands end only through provider or child exit; dead-generation settlement supplies their verdict.
  const liveTurnId = work().activeTurnId()
  // Read with the live turn, before the cancel settles it: the note is keyed by this turn.
  const stoppedTurnId = input.acceptedStop
    ? input.acceptedStop.turnId
    : structuredAgentSessionStoppedTurnId(work(), input.turnId)
  const namesTurnNotLive = structuredAgentSessionStopNamesTurnNotLive(input.turnId, liveTurnId)
  const runningCommand =
    input.stopChild !== undefined &&
    liveTurnId !== null &&
    isStructuredAgentSessionCommandTurnId(liveTurnId) &&
    !namesTurnNotLive
  const stoppedBefore =
    runningCommand &&
    (input.acceptedStop?.previouslyStopped ??
      structuredAgentSessionCommandWasStopped(ctx.journal, liveTurnId))
  // One rule for every agent: a chat's Stop ends its session, background work included; the next
  // send resumes the conversation. A task row's Stop has its own targeted path.
  const endsSession = input.endSession !== undefined
  const stoppedAt = Date.now()
  const noteIdentity = structuredAgentSessionStopNoteIdentity(
    stoppedTurnId ?? input.clientOperationId
  )
  let stoppedTurn: string | undefined = stoppedTurnId ?? undefined
  let noteWritten = input.acceptedStop?.requestNoteWrite !== undefined
  const writeNote = (body: AgentJournalStatusItem): Promise<void> => {
    noteWritten = true
    // A child end this Stop caused moved the fence past `ctx.fence`.
    const fence = Math.max(ctx.fence, input.noteFence?.() ?? ctx.fence)
    return writeStructuredAgentSessionStopNote(
      { journal: ctx.journal, fence, logger: ctx.logger, sessionId: ctx.sessionId },
      { identity: noteIdentity, body, stoppedTurn, fallbackScope: turnScope }
    )
  }
  const requestNoteWrite = input.acceptedStop
    ? input.acceptedStop.requestNoteWrite
    : endsSession && !namesTurnNotLive
      ? writeNote(note)
      : undefined
  // undefined means cancel threw and its effect is unknown.
  let stopOutcome: AgentSessionStopOutcome | undefined
  let taken: boolean | undefined
  let interruptFailed = false
  let refusal: AgentSessionCancelOutcome['refusal']
  try {
    const dispatchStatus = latestJournalDispatchObservation(ctx.journal, ctx.fence)
    const outcome: AgentSessionCancelOutcome = stoppedBefore
      ? { cancelled: false }
      : await ctx.adapter.cancelTurn({
          sessionId: ctx.sessionId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          fence: ctx.fence,
          ...(endsSession ? { stoppedAt } : {}),
          // Validate against the journal the client used to name its turn.
          resolveLiveTurnId: () => work().activeTurnId(),
          ...(dispatchStatus ? { dispatchStatus } : {}),
          ...(input.prompt ? { prompt: { itemId: input.prompt.itemId } } : {})
        })
    stopOutcome = outcome.stop
    taken = outcome.cancelled
    cancelled = outcome.cancelled
    refusal = outcome.refusal
    stoppedTurn = outcome.turnId
    interruptFailed = refusal !== undefined && refusal.turnNotRunning !== true
    // Check work first: a live turn must never wait on queued-message withdrawal.
    if (!cancelled && !isMainAgentWorking(ctx) && (await input.withdrewQueued) === true) {
      // Withdrawing all queued work confirms Stop regardless of provider no-op wording.
      cancelled = true
      note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
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
  // Accepted chat Stops retain runtime closure; other named cancellations keep their live-turn scope.
  if (endsSession && (input.acceptedStop || !namesTurnNotLive || taken !== false)) {
    // Accepted interrupts warrant wind-down even before their turn echo arrives.
    binding.closedByWindDown = true
    // Wind-down settles execution; provider control uncertainty survives in its outcome.
    const ended: AgentJournalStatusItem | null =
      note === null || (input.acceptedStop && !requestNoteWrite)
        ? null
        : { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    const stopNoteWrite = ended !== null ? (requestNoteWrite ?? writeNote(ended)) : undefined
    input.endSession?.({
      outcome: stopOutcome,
      noteFence: input.noteFence,
      operationId: input.clientOperationId,
      waitsForProvider: taken === true,
      stoppedAt,
      stopNote: noteIdentity,
      stopNoteWrite,
      settled: closeSettle
    })
    cancelled = true
    note = ended
  } else if (runningCommand && !cancelled) {
    const noteWrite =
      requestNoteWrite ?? writeNote({ kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED })
    await input.stopChild?.()
    await noteWrite
    cancelled = true
    note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
  } else if (
    !cancelled &&
    interruptFailed &&
    input.stopChild &&
    stillRunsStoppedTurn(ctx, stoppedTurnId)
  ) {
    let ended: boolean
    const noteWrite =
      requestNoteWrite ?? writeNote({ kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED })
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
      note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    } else if (taken !== undefined) {
      note = stopRefusedNote(ctx, refusal)
    }
    await noteWrite
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
    await settleTakenStop(ctx, stoppedTurn)
  }
  const value = { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled }
  if (note === null) {
    return { ok: true, value }
  }
  await (!noteWritten || note.text !== STOP_NOTE_CANCELLATION_REQUESTED
    ? writeNote(note)
    : binding.closedByWindDown
      ? undefined
      : requestNoteWrite)
  return { ok: true, value }
}
