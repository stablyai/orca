import { describe, expect, it, vi } from 'vitest'
import {
  createAppleSpeechEventReader,
  describeAppleSpeechError,
  parseAppleSpeechEvent
} from './apple-speech-events'

describe('parseAppleSpeechEvent', () => {
  it('reads the asset status arms the helper can report', () => {
    expect(
      parseAppleSpeechEvent('{"type":"status","status":"installed","locale":"en-US"}')
    ).toEqual({ type: 'status', status: 'installed', locale: 'en-US', reason: undefined })
  })

  it('rejects a status arm this build does not know', () => {
    expect(parseAppleSpeechEvent('{"type":"status","status":"pending"}')).toBeNull()
  })

  it('clamps progress into the fraction the settings list renders', () => {
    expect(parseAppleSpeechEvent('{"type":"progress","progress":1.4}')).toEqual({
      type: 'progress',
      progress: 1
    })
    expect(parseAppleSpeechEvent('{"type":"progress","progress":"half"}')).toBeNull()
  })

  it('keeps an empty transcript, which clears the live preview', () => {
    expect(parseAppleSpeechEvent('{"type":"partial","text":""}')).toEqual({
      type: 'partial',
      text: ''
    })
  })

  it('ignores anything that is not an event object', () => {
    expect(parseAppleSpeechEvent('not json')).toBeNull()
    expect(parseAppleSpeechEvent('[1,2]')).toBeNull()
    expect(parseAppleSpeechEvent('   ')).toBeNull()
  })
})

describe('createAppleSpeechEventReader', () => {
  it('joins events split across stdout chunks', () => {
    const events: unknown[] = []
    const reader = createAppleSpeechEventReader((event) => events.push(event))

    reader.push('{"type":"ready"}\n{"type":"par')
    expect(events).toEqual([{ type: 'ready', locale: undefined }])

    reader.push('tial","text":"hello"}\n')
    expect(events).toEqual([
      { type: 'ready', locale: undefined },
      { type: 'partial', text: 'hello' }
    ])
  })

  it('emits a last line that arrived without its newline', () => {
    const onEvent = vi.fn()
    const reader = createAppleSpeechEventReader(onEvent)

    reader.push('{"type":"final","text":"done"}')
    expect(onEvent).not.toHaveBeenCalled()

    reader.flush()
    expect(onEvent).toHaveBeenCalledWith({ type: 'final', text: 'done' })
  })
})

describe('describeAppleSpeechError', () => {
  it('explains the failures a user can act on', () => {
    expect(describeAppleSpeechError({ error: 'unsupported_macos' })).toContain('macOS 26')
    expect(describeAppleSpeechError({ error: 'locale_unsupported', detail: 'sv-SE' })).toContain(
      'sv-SE'
    )
  })

  it('falls back to the raw code so an unknown failure is still reportable', () => {
    expect(describeAppleSpeechError({ error: 'boom', detail: 'stack' })).toBe('boom: stack')
  })
})
