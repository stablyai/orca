import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

const ENQUEUED_AT = '2026-08-13T13:01:09.710Z'

function queuedCommandLine(
  overrides: { attachment?: Record<string, unknown> } & Record<string, unknown> = {}
): string {
  const { attachment, ...rest } = overrides
  return JSON.stringify({
    type: 'attachment',
    uuid: '6c98913b-d79d-4075-b44b-2f73789ead21',
    parentUuid: 'bf4ba06c-ffc5-4d62-94af-5e857d74ed11',
    isSidechain: false,
    timestamp: ENQUEUED_AT,
    ...rest,
    attachment: {
      type: 'queued_command',
      prompt: 'take a look while you are at it',
      commandMode: 'prompt',
      origin: { kind: 'human' },
      timestamp: ENQUEUED_AT,
      ...attachment
    }
  })
}

describe('decodeClaudeTranscriptLine — queued prompts', () => {
  it('decodes a queued command as a user message stamped at enqueue time', () => {
    expect(decodeClaudeTranscriptLine(queuedCommandLine(), 'fallback')).toEqual({
      id: '6c98913b-d79d-4075-b44b-2f73789ead21',
      role: 'user',
      blocks: [{ type: 'text', text: 'take a look while you are at it' }],
      timestamp: Date.parse(ENQUEUED_AT),
      source: 'transcript',
      queued: true
    })
  })

  // Why: `origin` is absent on many real records, so it cannot gate the decode.
  it('decodes a queued command that carries no origin field', () => {
    const line = JSON.stringify({
      type: 'attachment',
      uuid: 'no-origin',
      timestamp: ENQUEUED_AT,
      attachment: { type: 'queued_command', prompt: 'no origin here', commandMode: 'prompt' }
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'no origin here' }]
    })
  })

  // Why: these are ~46% of queued_command records, and the orchestration
  // transcript path has no noise filter to catch them downstream.
  it('drops task-notification queue entries the harness enqueues for itself', () => {
    const line = queuedCommandLine({
      attachment: {
        commandMode: 'task-notification',
        prompt: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>'
      }
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toBeNull()
  })

  // Why: an image-carrying queued prompt stores `prompt` as content blocks.
  it('decodes a queued command whose prompt is content blocks', () => {
    const line = queuedCommandLine({
      attachment: { prompt: [{ type: 'text', text: '[Image #1] look at this' }] }
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: '[Image #1] look at this' }]
    })
  })

  it('ignores attachments that are not queued commands', () => {
    const line = queuedCommandLine({ attachment: { type: 'file' } })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toBeNull()
  })

  it('ignores a queued command with no prompt text', () => {
    const line = queuedCommandLine({ attachment: { prompt: '   ' } })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toBeNull()
  })

  it('still drops queue bookkeeping records', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'remove',
      timestamp: ENQUEUED_AT,
      content: 'take a look while you are at it'
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toBeNull()
  })

  it('leaves ordinary user turns unchanged', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: ENQUEUED_AT,
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] }
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'first prompt' }]
    })
  })
})
