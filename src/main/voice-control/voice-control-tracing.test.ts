import { afterEach, describe, expect, it } from 'vitest'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import {
  traceVoiceReplySettled,
  traceVoiceReplySpeak,
  traceVoiceScreenDriver,
  traceVoiceStateTransition,
  traceVoiceToolDispatch,
  traceVoiceTranscript,
  voiceControlGateObserver
} from './voice-control-tracing'

describe('voice-control tracing', () => {
  afterEach(() => {
    _resetTracerForTests()
  })

  it('records without an active sink (noop path)', () => {
    expect(() => {
      traceVoiceStateTransition('live')
      traceVoiceToolDispatch('message_agent', 'oak')
      traceVoiceReplySpeak('tab-1:leaf', 'oak')
      traceVoiceReplySettled('tab-1:leaf')
      traceVoiceTranscript('user', 'clone the repo')
      traceVoiceScreenDriver('snapshot-failed', 'CDP "Accessibility.getFullAXTree" timed out')
      voiceControlGateObserver.recordCreateOutcome('requeued', 1500)
      voiceControlGateObserver.recordCreateOutcome('sent', null)
    }).not.toThrow()
  })

  it('records screen-driver events to the active sink, trimmed and capped', () => {
    const records: { name: string; attributes: Record<string, unknown> }[] = []
    setActiveSink({
      push: (record) =>
        records.push(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test installs the sink, so every pushed record is the span envelope the tracer itself produced.
          record as { name: string; attributes: Record<string, unknown> }
        ),
      flush: () => {},
      close: () => {}
    })

    traceVoiceScreenDriver('refused-devtools-held')
    traceVoiceScreenDriver('snapshot-failed', '  boom  ')
    traceVoiceScreenDriver('click-failed', 'x'.repeat(400))

    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({
      name: 'voice-control.screen',
      attributes: { event: 'refused-devtools-held' }
    })
    expect(records[0]?.attributes.detail).toBeUndefined()
    expect(records[1]?.attributes).toMatchObject({ event: 'snapshot-failed', detail: 'boom' })
    expect(String(records[2]?.attributes.detail)).toHaveLength(301)
  })

  it('records completed transcripts to the active sink, trimmed and capped', () => {
    const records: { name: string; attributes: Record<string, unknown> }[] = []
    setActiveSink({
      push: (record) =>
        records.push(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test installs the sink, so every pushed record is the span envelope the tracer itself produced.
          record as { name: string; attributes: Record<string, unknown> }
        ),
      flush: () => {},
      close: () => {}
    })

    traceVoiceTranscript('user', '  clone the repo  ')
    traceVoiceTranscript('assistant', 'on it')
    traceVoiceTranscript('user', '   ')
    traceVoiceTranscript('user', 'x'.repeat(600))

    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({
      name: 'voice-control.transcript',
      attributes: { role: 'user', text: 'clone the repo' }
    })
    expect(records[1]?.attributes).toMatchObject({ role: 'assistant', text: 'on it' })
    expect(String(records[2]?.attributes.text)).toHaveLength(501)
  })
})
