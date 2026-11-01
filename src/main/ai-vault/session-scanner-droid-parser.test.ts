import { expect, it } from 'vitest'
import { createDroidSessionResumeState } from './session-scanner-droid-parser'
import type { TranscriptMessage } from './session-transcript-consumers'

it.each([413, 256 * 1024 + 1])(
  'publishes %i-character Droid content before preview limits',
  async (length) => {
    const messages: TranscriptMessage[] = []
    const state = createDroidSessionResumeState(
      { path: 'droid-session.jsonl', mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
      { active: true, push: (message) => messages.push(message) }
    )
    const text = 'x'.repeat(length)
    state.consumeLine(
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      })
    )
    state.consumeLine(JSON.stringify({ type: 'message', role: 'user', text }))
    expect(messages).toEqual(
      ['assistant', 'user'].map((role) => ({
        role,
        text: text.slice(0, 256 * 1024),
        timestamp: null,
        ...(length > 256 * 1024 ? { textTruncated: true } : {})
      }))
    )
    const session = await state.finalize('linux')
    expect(session?.previewMessages.map((message) => message.text.length)).toEqual([220, 220])
  }
)
