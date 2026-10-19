import { describe, expect, it, vi } from 'vitest'
import type { VoiceControlToolActivityEvent } from '../../shared/voice-control-types'
import { RealtimeResponseGate } from './realtime-response-gate'
import type { VoiceControlSessionBackend } from './voice-control-session-backend'
import { routeVoiceControlSidebandEvent } from './voice-control-sideband-event-routing'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'

// The tracer writes to a durable file — pinned so tests never touch disk.
vi.mock('./voice-control-tracing', () => ({
  traceVoiceSidebandEvent: vi.fn(),
  traceVoiceTranscript: vi.fn()
}))

function harness() {
  const gate = new RealtimeResponseGate(() => {}, { recordCreateOutcome: () => {} })
  const toolCalls: { name: string; args: string; callId: string }[] = []
  const observed: Record<string, unknown>[] = []
  const backend: VoiceControlSessionBackend = {
    start: () => {},
    dispatchToolCall: (name, args, callId) => {
      toolCalls.push({ name, args, callId })
      return Promise.resolve()
    },
    observeEvent: (event) => {
      observed.push(event)
    },
    hasOutstandingWork: () => false,
    runId: () => 'run-1',
    dispose: () => {}
  }
  const toolActivity: VoiceControlToolActivityEvent[] = []
  const transcript: VoiceTranscriptEntry[] = []
  const route = (event: Record<string, unknown>) =>
    routeVoiceControlSidebandEvent({
      sessionId: 's1',
      gate,
      backend,
      emitToolActivity: (e) => toolActivity.push(e),
      recordTranscript: (e) => transcript.push(e),
      event
    })
  return { route, toolCalls, observed, toolActivity, transcript }
}

describe('routeVoiceControlSidebandEvent', () => {
  it('returns tool-call, dispatches it, and observes the event', () => {
    const { route, toolCalls, observed } = harness()
    const event = {
      type: 'response.function_call_arguments.done',
      name: 'list_agents',
      call_id: 'c1',
      arguments: '{}'
    }
    expect(route(event)).toBe('tool-call')
    expect(toolCalls).toEqual([{ name: 'list_agents', args: '{}', callId: 'c1' }])
    expect(observed).toEqual([event])
  })

  it('returns user-transcript and records the user line', () => {
    const { route, transcript } = harness()
    expect(
      route({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'clone the repo'
      })
    ).toBe('user-transcript')
    expect(transcript).toEqual([expect.objectContaining({ kind: 'user', text: 'clone the repo' })])
  })

  it('returns agent-transcript and records the assistant line', () => {
    const { route, transcript } = harness()
    expect(route({ type: 'response.output_audio_transcript.done', transcript: 'on it' })).toBe(
      'agent-transcript'
    )
    expect(transcript).toEqual([expect.objectContaining({ kind: 'assistant', text: 'on it' })])
  })

  it('returns lifecycle kinds for speech and response events', () => {
    const { route } = harness()
    expect(route({ type: 'input_audio_buffer.speech_started' })).toBe('speech-started')
    expect(route({ type: 'response.done' })).toBe('response-done')
  })

  it('returns ignored for unrecognized frames', () => {
    const { route } = harness()
    expect(route({ type: 'session.updated' })).toBe('ignored')
  })

  it('a malformed tool-call frame returns ignored and surfaces tool activity', () => {
    const { route, toolCalls, toolActivity } = harness()
    expect(route({ type: 'response.function_call_arguments.done', call_id: 'c9' })).toBe('ignored')
    expect(toolCalls).toHaveLength(0)
    expect(toolActivity).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        tool: 'sideband',
        detail: 'malformed tool call frame (c9)'
      })
    ])
  })
})
