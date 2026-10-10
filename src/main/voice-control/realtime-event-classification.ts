/**
 * Trichotomy for inbound sideband frames, ported from otto-voice's posture: an event
 * shaped like a tool call but missing a required field is a HARD failure (one bad event
 * on a healthy connection — surfaced, never silently skipped), while an event that simply
 * isn't a tool call passes through as a typed lifecycle/transcript event.
 */

type RealtimeEvent = Record<string, unknown>

export type RealtimeToolCallEvent = {
  kind: 'tool-call'
  name: string
  toolCallId: string
  argumentsJson: string
}

export type RealtimeTranscriptEvent = {
  kind: 'user-transcript' | 'agent-transcript'
  text: string
}

export type RealtimeLifecycleEvent = {
  kind: 'speech-started' | 'speech-stopped' | 'response-done'
}

export type RealtimePassthroughEvent = {
  kind: 'ignored'
}

export type ClassifiedRealtimeEvent =
  | RealtimeToolCallEvent
  | RealtimeTranscriptEvent
  | RealtimeLifecycleEvent
  | RealtimePassthroughEvent

export class MalformedToolCallError extends Error {
  constructor(
    message: string,
    readonly toolCallId: string | null
  ) {
    super(message)
    this.name = 'MalformedToolCallError'
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function classifyRealtimeEvent(event: RealtimeEvent): ClassifiedRealtimeEvent {
  switch (event.type) {
    case 'response.function_call_arguments.done': {
      const name = readString(event.name)
      const toolCallId = readString(event.call_id)
      const argumentsJson = readString(event.arguments)
      if (!name || !toolCallId || argumentsJson === null) {
        throw new MalformedToolCallError(
          'malformed function_call event: missing name, call_id, or arguments',
          toolCallId
        )
      }
      return { kind: 'tool-call', name, toolCallId, argumentsJson }
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const text = readString(event.transcript) ?? ''
      return { kind: 'user-transcript', text }
    }
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done': {
      const text = readString(event.transcript) ?? ''
      return { kind: 'agent-transcript', text }
    }
    case 'input_audio_buffer.speech_started':
      return { kind: 'speech-started' }
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'speech-stopped' }
    case 'response.done':
      return { kind: 'response-done' }
    default:
      return { kind: 'ignored' }
  }
}
