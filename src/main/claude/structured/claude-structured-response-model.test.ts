import { expect, it } from 'vitest'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  USER_MESSAGE
} from './claude-structured-session-test-support'

it('keeps ordinary answer metadata out of the model options exposed to clients', async () => {
  const claude = fakeClaude({
    initModel: 'claude-opus-5-5',
    initModels: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5' }]
  })
  const adapter = await acquired(claude)
  try {
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first',
      body: USER_MESSAGE,
      fence: 7
    })
    const connection = claude.connections[0]!
    claudeFrame(connection, {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: { id: 'answer', role: 'assistant', model: 'claude-opus-4-8', content: [] }
      }
    })
    claudeFrame(connection, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'answer',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Finished.' }]
      }
    })
    const { current } = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(current.model).toBe('claude-opus-5-5')
    expect(current).not.toHaveProperty('reportedModel')
  } finally {
    await adapter.closeAll()
  }
})
