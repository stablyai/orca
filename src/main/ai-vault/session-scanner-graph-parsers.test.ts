import { describe, expect, it } from 'vitest'
import { createAccumulator } from './session-scanner-accumulator'
import { consumeRovoHistoryEntry } from './session-scanner-graph-parsers'
import type { TranscriptMessage } from './session-transcript-consumers'

function rovoAccumulator(messages?: TranscriptMessage[]) {
  return createAccumulator({
    agent: 'rovo',
    sessionId: 'rovo-test',
    file: { path: '/tmp/rovo/metadata.json', mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
    ...(messages
      ? { messages: { active: true, push: (message: TranscriptMessage) => messages.push(message) } }
      : {})
  })
}

describe('AI Vault graph session parsers', () => {
  it.each([300, 256 * 1024 + 1])(
    'publishes %i-character Rovo history text while retaining its bounded preview',
    (length) => {
      const messages: TranscriptMessage[] = []
      const accumulator = rovoAccumulator(messages)
      const text = 'x'.repeat(length)
      consumeRovoHistoryEntry(accumulator, {
        role: 'user',
        parts: [
          { part_kind: 'tool-output', content: 'ignored' },
          { part_kind: 'user-prompt', content: text },
          { part_kind: 'text', text: 'tail' }
        ]
      })
      expect(messages).toEqual([
        {
          role: 'user',
          text: `${text}\ntail`.slice(0, 256 * 1024),
          timestamp: null,
          ...(length > 256 * 1024 ? { textTruncated: true } : {})
        }
      ])
      expect(accumulator.previewMessages[0]?.text).toHaveLength(220)
    }
  )
})
