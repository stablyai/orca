import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

describe('decodeClaudeTranscriptLine — system notices', () => {
  it('decodes a login-required informational notice into a bannerable system message', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'informational',
      content:
        'Remote Control disconnected — Your organization requires Trusted Devices for Remote Control, but this device is not enrolled. Please run `/login` in Claude Code to enroll this device.',
      level: 'warning',
      timestamp: '2026-08-13T13:26:51.452Z',
      uuid: '1da9c588-975e-4d06-b023-fba02612707d'
    })

    expect(decodeClaudeTranscriptLine(line, 'fallback')).toEqual({
      id: '1da9c588-975e-4d06-b023-fba02612707d',
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: 'Remote Control disconnected — Your organization requires Trusted Devices for Remote Control, but this device is not enrolled. Please run `/login` in Claude Code to enroll this device.'
        }
      ],
      timestamp: Date.parse('2026-08-13T13:26:51.452Z'),
      source: 'transcript',
      noticeKind: 'login-required'
    })
  })

  it('decodes a non-auth informational notice as a generic notice', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'informational',
      content: 'Context was compacted to make room for new messages.',
      timestamp: '2026-08-13T13:00:00.000Z',
      uuid: 'notice-1'
    })

    const decoded = decodeClaudeTranscriptLine(line, 'fallback')
    expect(decoded?.noticeKind).toBe('generic')
    expect(decoded?.role).toBe('system')
  })

  it('keeps bookkeeping system subtypes silent, unchanged from before this notice path existed', () => {
    const stopHookSummary = JSON.stringify({
      type: 'system',
      subtype: 'stop_hook_summary',
      hookCount: 3,
      timestamp: '2026-08-13T14:44:23.786Z',
      uuid: 'e6f19769-d9b9-44eb-86e4-0092bf4cf6da'
    })
    const turnDuration = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 5419,
      timestamp: '2026-08-13T14:44:23.787Z',
      uuid: 'cb4072ea-68ed-4140-a552-08de711c002b'
    })

    expect(decodeClaudeTranscriptLine(stopHookSummary, 'fallback')).toBeNull()
    expect(decodeClaudeTranscriptLine(turnDuration, 'fallback')).toBeNull()
  })

  it('drops an informational notice with no content instead of a blank banner', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'informational',
      timestamp: '2026-08-13T13:00:00.000Z',
      uuid: 'notice-2'
    })

    expect(decodeClaudeTranscriptLine(line, 'fallback')).toBeNull()
  })

  it('still decodes ordinary assistant messages unaffected by the system-notice branch', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Hola' }] },
      timestamp: '2026-08-13T14:44:23.542Z',
      uuid: '18d90d27-d0f1-481b-9735-b18b5f005307'
    })

    const decoded = decodeClaudeTranscriptLine(line, 'fallback')
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.noticeKind).toBeUndefined()
  })
})
