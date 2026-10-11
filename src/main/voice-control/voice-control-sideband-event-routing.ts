import type { VoiceControlToolActivityEvent } from '../../shared/voice-control-types'
import { classifyRealtimeEvent, MalformedToolCallError } from './realtime-event-classification'
import type { RealtimeResponseGate } from './realtime-response-gate'
import type { VoiceControlSessionBackend } from './voice-control-session-backend'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'
import { traceVoiceSidebandEvent, traceVoiceTranscript } from './voice-control-tracing'

/**
 * One sideband frame's route through the session: gate observation, classification,
 * backend observation/dispatch, and transcript recording. Provider-side records (refused
 * injections, note acks, response end states) are traced but otherwise ignored here.
 */
export function routeVoiceControlSidebandEvent(args: {
  sessionId: string
  gate: RealtimeResponseGate
  /** The live session's backend, read per event — null once the session is torn down. */
  backend: VoiceControlSessionBackend | null
  emitToolActivity: (event: VoiceControlToolActivityEvent) => void
  recordTranscript: (entry: VoiceTranscriptEntry, options?: { durableText?: string }) => void
  event: Record<string, unknown>
}): void {
  const { sessionId, gate, backend, event } = args
  gate.observe(event)
  traceVoiceSidebandEvent(event)
  let classified
  try {
    classified = classifyRealtimeEvent(event)
  } catch (error) {
    if (error instanceof MalformedToolCallError) {
      // Why surfaced, not skipped: one bad frame on a healthy connection must be
      // visible; the session continues (otto-voice posture).
      args.emitToolActivity({
        sessionId,
        tool: 'sideband',
        detail: `malformed tool call frame (${error.toolCallId ?? 'no call id'})`
      })
      return
    }
    throw error
  }
  backend?.observeEvent(event)
  if (classified.kind === 'tool-call') {
    void backend?.dispatchToolCall(classified.name, classified.argumentsJson, classified.toolCallId)
  } else if (classified.kind === 'user-transcript') {
    traceVoiceTranscript('user', classified.text)
    args.recordTranscript({ ts: Date.now(), kind: 'user', text: classified.text })
  } else if (classified.kind === 'agent-transcript') {
    traceVoiceTranscript('assistant', classified.text)
    args.recordTranscript({ ts: Date.now(), kind: 'assistant', text: classified.text })
  }
}
