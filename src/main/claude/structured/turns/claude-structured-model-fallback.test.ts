import { expect, it } from 'vitest'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  USER_MESSAGE
} from '../claude-structured-session-test-support'
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
    (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.fallbackModel
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
    expect(await read()).toBe('claude-opus-4-8')
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

it('sends a model picked during a fallback, even the saved one, and clears it only once Claude accepts', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5-5' })
  const adapter = await acquired(claude)
  const connection = claude.connections[0]!
  const ids = { sessionId: 'session-1', fence: 7 }
  const shown = async () => (await adapter.readOptions(ids)).current.fallbackModel
  const setModels = () => connection.calls.filter((call) => call.subtype === 'set_model')
  const turn = async (clientMessageId: string, fallsBack = false) => {
    const outcome = await adapter.dispatch({
      ...ids,
      clientMessageId,
      body: USER_MESSAGE,
      executionOptions: { model: 'claude-opus-5-5' }
    })
    if (fallsBack) {
      claudeFrame(connection, {
        type: 'assistant',
        uuid: `${clientMessageId}-answer`,
        parent_tool_use_id: null,
        message: {
          id: clientMessageId,
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [FALLBACK]
        }
      })
    }
    claudeFrame(connection, {
      type: 'result',
      subtype: 'success',
      uuid: `${clientMessageId}-end`,
      num_turns: 1
    })
    return outcome.state
  }
  try {
    await adapter.setOption({ ...ids, key: 'model', value: 'claude-opus-5-5' })
    await turn('flagged', true)
    // Without a pick the session stays on the fallback Claude chose.
    await turn('unpicked')
    expect(setModels()).toHaveLength(1)
    expect(await shown()).toBe('claude-opus-4-8')

    adapter.noteModelPick(ids)
    await turn('picked')
    expect(setModels()).toHaveLength(2)
    expect(setModels().at(-1)?.params).toEqual({ model: 'claude-opus-5-5' })
    expect(await shown()).toBeUndefined()

    await turn('flagged-again', true)
    claude.routes.set_model = () => {
      throw new Error('model refused')
    }
    adapter.noteModelPick(ids)
    expect(await turn('refused')).toBe('rejected')
    expect(setModels()).toHaveLength(3)
    expect(await shown()).toBe('claude-opus-4-8')
  } finally {
    await adapter.closeAll()
  }
})
