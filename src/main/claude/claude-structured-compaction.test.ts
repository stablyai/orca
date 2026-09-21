import { describe, expect, it } from 'vitest'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { isClaudeCompactionContent } from './claude-structured-compaction'

describe('Claude compaction transcript content', () => {
  it('keeps generated summaries and command echoes out of the transcript only during explicit compaction', async () => {
    const tracker = new StructuredSessionCompaction()
    const event = {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'user',
        session_id: 'provider',
        uuid: 'summary',
        message: { role: 'user', content: 'generated compaction summary' }
      }
    }
    expect(isClaudeCompactionContent(tracker, event)).toBe(false)
    const completion = tracker.run('orca-session', 'provider', async () => ({}))
    expect(isClaudeCompactionContent(tracker, event)).toBe(true)
    expect(isClaudeCompactionContent(tracker, { ...event, sessionId: 'other' })).toBe(false)
    expect(isClaudeCompactionContent(tracker, { ...event, message: { type: 'result' } })).toBe(
      false
    )
    tracker.ended('orca-session')
    await completion
    expect(isClaudeCompactionContent(tracker, event)).toBe(false)
  })
})
