import { startSpan } from '../observability/tracer'
import type { ResponseGateObserver } from './realtime-response-gate'
import { asWireRecord } from './realtime-wire-record'

/**
 * Instant trace records for the speech pipeline, written to the host's
 * `logs/main.trace.ndjson`. This is the after-the-fact answer to "the reply never
 * played": every tool dispatch, reply speak, reply settle, and gate requeue leaves a
 * record, so a silent session shows exactly which stage went quiet. Spans end
 * immediately (event markers, not durations) — a jammed reply must still leave its
 * speak record behind.
 */

export function traceVoiceStateTransition(state: string, detail?: string): void {
  startSpan('voice-control.session', {
    attributes: { state, ...(detail ? { detail } : {}) }
  }).end()
}

export function traceVoiceToolDispatch(tool: string, target?: string): void {
  startSpan('voice-control.tool', {
    attributes: { tool, ...(target ? { target } : {}) }
  }).end()
}

export function traceVoiceReplySpeak(paneKey: string, spokenName: string): void {
  startSpan('voice-control.reply.speak', { attributes: { paneKey, spokenName } }).end()
}

export function traceVoiceReplySettled(paneKey: string): void {
  startSpan('voice-control.reply.settled', { attributes: { paneKey } }).end()
}

/**
 * The service's one-call hook for inbound provider events worth a record: error
 * rejections, the note-injection ack, and every response's end state. Routed here (not
 * inlined at the call site) so the service stays a dispatcher and the wire-shape reads
 * live with the spans they feed.
 */
export function traceVoiceSidebandEvent(event: Record<string, unknown>): void {
  if (event.type === 'error') {
    traceVoiceProviderError(event)
    return
  }
  if (event.type === 'conversation.item.created') {
    const item = asWireRecord(event.item)
    if (item?.role === 'system' && typeof item.id === 'string') {
      traceVoiceNoteInjection(item.id)
    }
    return
  }
  if (event.type === 'response.done') {
    traceVoiceResponseDone(event)
  }
}

/** Cap: provider error blobs can carry whole event echoes. */
const PROVIDER_ERROR_TRACE_LIMIT = 300

/** Ellipsis-caps a string for the NDJSON trace; the redactor still runs after. */
function capped(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Inbound provider `error` events — the rejections the gate doesn't own (a refused
 * conversation.item.create or session.update) vanish silently without this record; a
 * relay the model never saw shows up here as the refusal, not as a mystery.
 */
export function traceVoiceProviderError(event: Record<string, unknown>): void {
  const error =
    typeof event.error === 'object' && event.error !== null
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object/non-null check above is the full wire contract for the error payload.
        (event.error as Record<string, unknown>)
      : null
  const message = String(error?.message ?? event.message ?? '').trim()
  startSpan('voice-control.provider-error', {
    attributes: {
      ...(typeof event.event_id === 'string' ? { eventId: event.event_id } : {}),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      message: capped(message, PROVIDER_ERROR_TRACE_LIMIT)
    }
  }).end()
}

const TRANSCRIPT_TRACE_LIMIT = 500

/**
 * Completed transcripts (what the user said, what the coordinator said back), recorded so
 * a confusing session can be replayed from the trace file instead of guessed at. The mic
 * already streams this audio to OpenAI; the local record is the diagnostic copy.
 */
export function traceVoiceTranscript(role: 'user' | 'assistant', text: string): void {
  const trimmed = text.trim()
  if (!trimmed) {
    return
  }
  startSpan('voice-control.transcript', {
    attributes: {
      role,
      text: capped(trimmed, TRANSCRIPT_TRACE_LIMIT)
    }
  }).end()
}

/**
 * The provider's echo confirming an injected system note actually entered the
 * conversation. Without it, "the model never saw the relay" is indistinguishable from
 * "the model saw it and ignored it" — the two need opposite fixes.
 */
export function traceVoiceNoteInjection(itemId: string): void {
  startSpan('voice-control.note.acked', { attributes: { itemId } }).end()
}

/**
 * Every response's end state. A relay that played only its prefix reads here as
 * `cancelled`/`turn_detected` (the user barged in) versus `completed` (the model really
 * had nothing to say) — the difference between fine and a dead injection.
 */
export function traceVoiceResponseDone(event: Record<string, unknown>): void {
  const response =
    typeof event.response === 'object' && event.response !== null
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object/non-null check above is the full wire contract for a response record.
        (event.response as Record<string, unknown>)
      : null
  const details =
    typeof response?.status_details === 'object' && response.status_details !== null
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object/non-null check above is the full wire contract for status details.
        (response.status_details as Record<string, unknown>)
      : null
  startSpan('voice-control.response', {
    attributes: {
      ...(typeof response?.id === 'string' ? { id: response.id } : {}),
      status: String(response?.status ?? 'unknown'),
      ...(typeof details?.type === 'string' ? { detailType: details.type } : {}),
      ...(typeof details?.reason === 'string' ? { reason: details.reason } : {})
    }
  }).end()
}

/** Low-volume by construction (creates are tool answers + reply speech only). */
export const voiceControlGateObserver: ResponseGateObserver = {
  recordCreateOutcome(outcome, queuedWaitMs) {
    startSpan('voice-control.gate', {
      attributes: { outcome, ...(queuedWaitMs !== null ? { queuedWaitMs } : {}) }
    }).end()
  }
}

/** Cap: CDP error strings can carry whole parameter blobs. */
const SCREEN_TRACE_DETAIL_LIMIT = 300

/**
 * The screen driver's ledger. see_screen/click_element/type_into/read_terminal degrade to
 * null by design (never crash the model's turn) — these spans are what make a silent
 * "the screen became unavailable" diagnosable from the trace file instead of a guess.
 */
export function traceVoiceScreenDriver(event: string, detail?: string): void {
  const trimmed = detail?.trim()
  startSpan('voice-control.screen', {
    attributes: {
      event,
      ...(trimmed ? { detail: capped(trimmed, SCREEN_TRACE_DETAIL_LIMIT) } : {})
    }
  }).end()
}
