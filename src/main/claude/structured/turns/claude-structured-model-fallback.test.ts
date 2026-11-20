import { expect, it } from 'vitest'
import { acquired, claudeFrame, fakeClaude } from '../claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

const FALLBACK = {
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' }
}

it('reports a main-thread fallback as the running model until a model write replaces it', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5-5' })
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = await acquired(claude, {}, events)
  const connection = claude.connections[0]!
  const read = async () =>
    (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).modelFallback
  const answer = (uuid: string, parent: string | null) =>
    claudeFrame(connection, {
      type: 'assistant',
      uuid,
      parent_tool_use_id: parent,
      message: { id: uuid, role: 'assistant', model: 'claude-opus-4-8', content: [FALLBACK] }
    })
  try {
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'model',
      value: 'claude-opus-5-5'
    })
    // A subagent's fallback leaves the session model unchanged.
    answer('subagent', 'task-1')
    expect(await read()).toBeUndefined()
    answer('main', null)
    expect(await read()).toEqual({ model: 'claude-opus-4-8', requested: 'claude-opus-5-5' })
    expect(events.findLast((event) => event.type === 'options-reported')).toMatchObject({
      reportedOptions: { fallbackModel: 'claude-opus-4-8' }
    })
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'model',
      value: 'claude-sonnet-5'
    })
    expect(await read()).toBeUndefined()
  } finally {
    await adapter.closeAll()
  }
})
