import { describe, expect, it } from 'vitest'
import { classifyRealtimeEvent, MalformedToolCallError } from './realtime-event-classification'

describe('classifyRealtimeEvent', () => {
  it('classifies a complete tool call', () => {
    expect(
      classifyRealtimeEvent({
        type: 'response.function_call_arguments.done',
        name: 'list_agents',
        call_id: 'call_1',
        arguments: '{}'
      })
    ).toEqual({ kind: 'tool-call', name: 'list_agents', toolCallId: 'call_1', argumentsJson: '{}' })
  })

  it('throws a hard failure for a function-call shape missing fields, keeping the call id', () => {
    try {
      classifyRealtimeEvent({ type: 'response.function_call_arguments.done', call_id: 'call_9' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedToolCallError)
      if (error instanceof MalformedToolCallError) {
        expect(error.toolCallId).toBe('call_9')
      }
    }
  })

  it('maps user and agent transcript completions', () => {
    expect(
      classifyRealtimeEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello'
      })
    ).toEqual({ kind: 'user-transcript', text: 'hello' })
    expect(
      classifyRealtimeEvent({ type: 'response.output_audio_transcript.done', transcript: 'hi' })
    ).toEqual({ kind: 'agent-transcript', text: 'hi' })
  })

  it('maps speech lifecycle events', () => {
    expect(classifyRealtimeEvent({ type: 'input_audio_buffer.speech_started' })).toEqual({
      kind: 'speech-started'
    })
    expect(classifyRealtimeEvent({ type: 'response.done' })).toEqual({ kind: 'response-done' })
  })

  it('ignores everything else, never raises', () => {
    expect(classifyRealtimeEvent({ type: 'session.updated' })).toEqual({ kind: 'ignored' })
    expect(classifyRealtimeEvent({})).toEqual({ kind: 'ignored' })
  })
})
