import './claude-conversation-worker.test-fixture'

import { describe, expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from '../structured/journal/claude-structured-journal-translation'

import {
  SESSION,
  SID,
  chatTurn,
  outsideTurn,
  chat
} from './claude-transcript-catch-up-test-support'
// Real disk tail → isolated translator → deferred sink → on-disk journal contracts.
import * as transcriptTail from './claude-transcript-tail'

describe('Claude chat catch-up', () => {
  it('does not place historical lifecycle after live work that arrives during its read', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    const read = transcriptTail.readClaudeTranscriptTail
    const live = createClaudeJournalTranslator({ sink: c.deferred.sink })
    vi.spyOn(transcriptTail, 'readClaudeTranscriptTail').mockImplementationOnce(async (input) => {
      const tail = await read(input)
      live.handle({
        type: 'message',
        sessionId: SESSION,
        message: {
          type: 'stream_event',
          uuid: 'wake',
          session_id: SID,
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'live-wake' } }
        }
      })
      return tail
    })
    expect(await c.open('a1')).toBe(false)
    expect(c.rows()).not.toContain('user:ask 2')
    const running = c.journal.snapshot().items.findLast((item) => item.body.kind === 'turn')
    expect(running?.body).toMatchObject({ state: 'running' })
    live.dispose()
  })
})
