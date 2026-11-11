import { expect, it } from 'vitest'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  USER_MESSAGE
} from './claude-structured-session-test-support'
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
      expect((await read()).current.reportedModel).toBe('claude-opus-5-5')
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
      model: 'claude-opus-5-5',
      reportedModel: 'claude-opus-4-8',
      confirmed: expect.arrayContaining(['model'])
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'options-reported',
        reportedOptions: expect.objectContaining({ reportedModel: 'claude-opus-4-8' })
      })
    )
    claudeFrame(connection, { type: 'system', subtype: 'status', permissionMode: 'plan' })
    expect(events.findLast((event) => event.type === 'options-reported')).toMatchObject({
      reportedOptions: { reportedModel: 'claude-opus-4-8', reportedPermissionMode: 'plan' }
    })
    claudeFrame(connection, {
      type: 'stream_event',
      uuid: 'restored',
      event: { type: 'message_start', message: { role: 'assistant', model: 'claude-opus-5-5' } }
    })
    expect((await read()).current.reportedModel).toBe('claude-opus-5-5')
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-4-8' })
    expect((await read()).current).toMatchObject({
      model: 'claude-opus-4-8',
      reportedModel: 'claude-opus-4-8'
    })
    await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'model', value: 'sonnet' })
    expect((await read()).current.reportedModel).toBeUndefined()
  } finally {
    await adapter.closeAll()
  }
})

it('retains the init context suffix when the response reports the same bare model', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5-5[1m]' })
  const adapter = await acquired(claude)
  const connection = claude.connections[0]!
  try {
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first-response',
      body: USER_MESSAGE,
      fence: 7
    })
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]' })
    claudeFrame(connection, {
      type: 'assistant',
      uuid: 'first-response',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [] }
    })
    expect(
      (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.reportedModel
    ).toBe('claude-opus-5-5[1m]')
    await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'model', value: 'opus' })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'after-context-pick',
      body: USER_MESSAGE,
      fence: 7
    })
    claudeFrame(connection, {
      type: 'assistant',
      uuid: 'after-context-pick',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [] }
    })
    expect(
      (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.reportedModel
    ).toBe('claude-opus-5-5')
  } finally {
    await adapter.closeAll()
  }
})

it('keeps a model picked during a turn over that turn’s later replies until a turn runs it', async () => {
  const claude = fakeClaude({ initModel: 'claude-sonnet-5-5' })
  const adapter = await acquired(claude)
  const connection = claude.connections[0]!
  const read = async () => (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
  const reply = (uuid: string, model: string) =>
    claudeFrame(connection, {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', model, content: [] }
    })
  try {
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'running',
      body: USER_MESSAGE,
      fence: 7
    })
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' })
    reply('before-pick', 'claude-sonnet-5-5')
    await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'model', value: 'haiku' })
    reply('same-turn', 'claude-sonnet-5-5')
    expect(await read()).toMatchObject({ model: 'haiku' })
    expect((await read()).reportedModel).toBeUndefined()
    expect(connection.calls).toContainEqual({ subtype: 'set_model', params: { model: 'haiku' } })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'next',
      body: USER_MESSAGE,
      fence: 7
    })
    reply('next-turn', 'claude-haiku-5-5')
    expect(await read()).toMatchObject({ model: 'haiku', reportedModel: 'claude-haiku-5-5' })
  } finally {
    await adapter.closeAll()
  }
})

it('retires the answered model on a saved pick until a turn carries that pick', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5-5' })
  const adapter = await acquired(claude)
  const connection = claude.connections[0]!
  const read = async () => (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
  const answer = (uuid: string, model: string) =>
    claudeFrame(connection, {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', model, content: [] }
    })
  const turn = async (clientMessageId: string, model: string) => {
    claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId,
      body: USER_MESSAGE,
      executionOptions: { model },
      fence: 7
    })
  }
  try {
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    answer('fallback', 'claude-opus-4-8')
    expect((await read()).reportedModel).toBe('claude-opus-4-8')

    adapter.noteOptionPick({ sessionId: 'session-1', fence: 7, key: 'model', value: 'sonnet' })
    answer('same-turn', 'claude-opus-4-8')
    expect((await read()).reportedModel).toBeUndefined()
    expect((await read()).confirmed ?? []).not.toContain('model')

    // A message accepted before the pick runs the model it captured.
    await turn('queued-before-pick', 'opus')
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    answer('queued-answer', 'claude-opus-5-5')
    expect((await read()).reportedModel).toBeUndefined()

    await turn('carries-pick', 'sonnet')
    expect(connection.calls).toContainEqual({ subtype: 'set_model', params: { model: 'sonnet' } })
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' })
    answer('next-fallback', 'claude-opus-4-8')
    expect((await read()).reportedModel).toBe('claude-opus-4-8')
  } finally {
    await adapter.closeAll()
  }
})
