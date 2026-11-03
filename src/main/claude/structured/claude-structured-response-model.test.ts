import { expect, it } from 'vitest'
import { acquired, claudeFrame, fakeClaude } from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

it('publishes the main response model after fallback and restoration, ignoring child, foreign and synthetic frames', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5-5' })
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = await acquired(claude, {}, events)
  const connection = claude.connections[0]!
  const read = () => adapter.readOptions({ sessionId: 'session-1', fence: 7 })
  try {
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    expect((await read()).current.model).toBe('claude-opus-5-5')
    for (const patch of [
      { parent_tool_use_id: 'child-tool' },
      { session_id: 'another-session' },
      { message: { role: 'assistant', model: '<synthetic>', content: [] } }
    ]) {
      claudeFrame(connection, {
        type: 'assistant',
        uuid: 'ignore',
        message: { role: 'assistant', model: 'claude-opus-4-8', content: [] },
        ...patch
      })
      expect((await read()).current.model).toBe('claude-opus-5-5')
    }
    claudeFrame(connection, {
      type: 'assistant',
      uuid: 'fallback',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }
        ]
      }
    })
    expect((await read()).current).toMatchObject({
      model: 'claude-opus-4-8',
      confirmed: expect.arrayContaining(['model'])
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'options-reported',
        reportedOptions: expect.objectContaining({ model: 'claude-opus-4-8' })
      })
    )
    claudeFrame(connection, {
      type: 'stream_event',
      uuid: 'restored',
      event: { type: 'message_start', message: { role: 'assistant', model: 'claude-opus-5-5' } }
    })
    expect((await read()).current.model).toBe('claude-opus-5-5')
  } finally {
    await adapter.closeAll()
  }
})
