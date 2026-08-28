import { describe, expect, it } from 'vitest'
import { isAgentNoticeMessage } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

const LOGIN_NOTICE =
  'Remote Control disconnected — Your organization requires Trusted Devices for Remote Control, but this device is not enrolled. Please run `/login` in Claude Code to enroll this device.'

function decode(record: Record<string, unknown>) {
  return decodeClaudeTranscriptLine(JSON.stringify(record), 'fallback')
}

describe('decodeClaudeTranscriptLine — system notices', () => {
  it('surfaces a type:system subtype:informational login notice as an agent notice', () => {
    const decoded = decode({
      type: 'system',
      subtype: 'informational',
      content: LOGIN_NOTICE,
      level: 'warning',
      timestamp: '2026-08-13T13:26:51.452Z',
      uuid: '1da9c588-975e-4d06-b023-fba02612707d'
    })

    expect(decoded).toEqual({
      id: '1da9c588-975e-4d06-b023-fba02612707d',
      role: 'system',
      blocks: [{ type: 'text', text: LOGIN_NOTICE }],
      timestamp: Date.parse('2026-08-13T13:26:51.452Z'),
      source: 'transcript',
      notice: { level: 'warning' }
    })
    expect(isAgentNoticeMessage(decoded!)).toBe(true)
  })

  it('surfaces an unknown future subtype when it contains user-facing copy', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'workspace_policy_notice',
        content: 'This workspace now requires approval.',
        uuid: 'future-1'
      })
    ).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'This workspace now requires approval.' }],
      notice: { level: 'info' }
    })
  })

  it('does not apply API retry suppression to an unknown subtype', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'workspace_policy_notice',
        source: 'request_retry',
        content: 'Approval is still required.',
        uuid: 'future-retry-source-1'
      })
    ).toMatchObject({
      blocks: [{ type: 'text', text: 'Approval is still required.' }],
      notice: { level: 'info' }
    })
  })

  it.each([
    'stop_hook_summary',
    'turn_duration',
    'away_summary',
    'local_command',
    'hook_callback',
    'init',
    'compact_boundary'
  ])('keeps known noise subtype %s silent', (subtype) => {
    expect(
      decode({
        type: 'system',
        subtype,
        content: subtype === 'compact_boundary' ? 'Conversation compacted' : 'System detail',
        uuid: `${subtype}-1`
      })
    ).toBeNull()
  })

  it.each([
    {
      source: 'request_retry',
      retryAttempt: 2,
      retryInMs: 1_000,
      maxRetries: 10,
      error: { message: 'Connection error.', formatted: 'Unable to connect to API' }
    },
    {
      source: 'connection_retry',
      retryAttempt: 5,
      retryInMs: 8_000,
      maxRetries: 10,
      error: 'Connection failed; retrying'
    }
  ])('keeps $source API retry progress silent', (retry) => {
    expect(
      decode({
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        uuid: `api-${retry.source}-1`,
        ...retry
      })
    ).toBeNull()
  })

  it('surfaces a source-less API error using formatted error copy', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        error: { message: 'Connection error.', formatted: 'Unable to connect to API' },
        uuid: 'api-error-1'
      })
    ).toMatchObject({
      blocks: [{ type: 'text', text: 'Unable to connect to API' }],
      notice: { level: 'error' }
    })
  })

  it('surfaces model refusal fallback copy', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'model_refusal_fallback',
        content: 'Switched to a fallback model',
        level: 'warning',
        uuid: 'model-fallback-1'
      })
    ).toMatchObject({
      blocks: [{ type: 'text', text: 'Switched to a fallback model' }],
      notice: { level: 'warning' }
    })
  })

  it.each(['informational', 'future_notice', 'api_error'])(
    'drops %s records with no extractable copy instead of a blank banner',
    (subtype) => {
      expect(
        decode({
          type: 'system',
          subtype,
          timestamp: '2026-08-13T13:00:00.000Z',
          uuid: 'notice-empty'
        })
      ).toBeNull()
    }
  )

  it('does not mark ordinary assistant turns or interrupt status as agent notices', () => {
    const assistant = decode({
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Hola' }] },
      timestamp: '2026-08-13T14:44:23.542Z',
      uuid: '18d90d27-d0f1-481b-9735-b18b5f005307'
    })
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.notice).toBeUndefined()
    expect(isAgentNoticeMessage(assistant!)).toBe(false)

    const interrupted = decode({
      type: 'user',
      uuid: 'interrupt-row',
      interruptedMessageId: 'assistant-request-1',
      timestamp: '2026-07-16T23:46:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }]
      }
    })
    expect(interrupted?.role).toBe('system')
    expect(interrupted?.notice).toBeUndefined()
    expect(isAgentNoticeMessage(interrupted!)).toBe(false)
  })
})
