import { expect, it } from 'vitest'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  USER_MESSAGE
} from '../claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

// As Claude Code 2.1.329 emits it for a refused main-thread turn.
const fallbackFrame = (uuid: string, scope: 'session' | 'local') => ({
  type: 'system',
  subtype: 'model_refusal_fallback',
  trigger: 'refusal',
  direction: 'retry',
  scope,
  original_model: 'claude-opus-5-5',
  fallback_model: 'claude-opus-4-8',
  request_id: null,
  uuid
})

it('reports a session-scope fallback as the running model until a model write replaces it', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5-5' })
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = await acquired(claude, {}, events)
  const connection = claude.connections[0]!
  const read = async () =>
    (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.fallbackModel
  try {
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'model',
      value: 'claude-opus-5-5'
    })
    // A subagent or /btw fallback leaves the session model unchanged.
    claudeFrame(connection, fallbackFrame('local', 'local'))
    expect(await read()).toBeUndefined()
    claudeFrame(connection, fallbackFrame('session', 'session'))
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
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = await acquired(claude, {}, events)
  const connection = claude.connections[0]!
  const ids = { sessionId: 'session-1', fence: 7 }
  const shown = async () => (await adapter.readOptions(ids)).current.fallbackModel
  const setModels = () => connection.calls.filter((call) => call.subtype === 'set_model')
  const turn = async (clientMessageId: string, fallsBack = false) => {
    const outcome = await adapter.dispatch({
      ...ids,
      clientMessageId,
      body: USER_MESSAGE,
      // The first turn runs Claude's default; later turns carry the model it ran as the saved choice.
      executionOptions: clientMessageId === 'flagged' ? {} : { model: 'claude-opus-5-5' }
    })
    if (fallsBack) {
      claudeFrame(connection, fallbackFrame(`${clientMessageId}-fallback`, 'session'))
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
    await turn('flagged', true)
    // Without a pick the session stays on the fallback Claude chose.
    await turn('unpicked')
    expect(setModels()).toHaveLength(0)
    expect(await shown()).toBe('claude-opus-4-8')

    adapter.noteModelPick(ids)
    // The pick reaches every client's status before the turn that applies it.
    expect(events.at(-1)).toMatchObject({
      type: 'options-reported',
      reportedOptions: { fallbackModel: undefined }
    })
    expect(await shown()).toBeUndefined()
    await turn('picked')
    expect(setModels()).toHaveLength(1)
    expect(setModels().at(-1)?.params).toEqual({ model: 'claude-opus-5-5' })
    expect(await shown()).toBeUndefined()
  } finally {
    await adapter.closeAll()
  }
})
