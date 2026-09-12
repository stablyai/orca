// What the adapter reports for one turn: how a dispatch is admitted and named,
// and which turn a cancellation is allowed to interrupt.

import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import {
  acquired,
  fakeClaude,
  invokeCanUseTool,
  PROVIDER_SESSION_ID,
  USER_MESSAGE
} from './claude-structured-session-test-support'

describe('ClaudeStructuredSessionAdapter turns and controls', () => {
  it('binds a prompt cancellation to the provider turn that created it', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const adapter = await acquired(claude)
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    invokeCanUseTool(claude.connections[0], 'Bash', 'permission-1', 'tool-1')
    adapter.bindPromptItemId('session-1', 'journal-approval', 'permission-1')

    expect(
      adapter.promptCancellation?.({
        sessionId: 'session-1',
        itemId: 'journal-approval',
        fence: 7
      })
    ).toEqual({ turnId: 'turn-1', itemIds: ['journal-approval'] })
    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        promptItemId: 'unrelated-prompt'
      })
    ).resolves.toEqual({ cancelled: false })
    expect(claude.connections[0].calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  })

  it('keeps the cancelled receipt when the matching SDK prompt aborts during interrupt', async () => {
    const controller = new AbortController()
    const events: Parameters<typeof acquired>[2] = []
    const claude = fakeClaude({
      replayUuid: 'turn-1',
      routes: { interrupt: () => controller.abort() }
    })
    const adapter = await acquired(claude, {}, events)
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    const pending = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-1', 'tool-1', {
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-approval', 'permission-1')

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        promptItemId: 'journal-approval',
        promptCancellationId: 'prompt-cancel:operation-1'
      })
    ).resolves.toEqual({ cancelled: true })
    await expect(pending.promise).resolves.toBeNull()
    expect(events.at(-1)).toMatchObject({
      type: 'prompt-cancelled',
      promptKey: 'permission-1',
      settlementId: 'prompt-cancel:operation-1'
    })
    expect(
      adapter.promptCancellation?.({
        sessionId: 'session-1',
        itemId: 'journal-approval',
        fence: 7
      })
    ).toBeNull()
  })

  it('treats an SDK prompt abort as confirmation when the interrupt reply says not running', async () => {
    const controller = new AbortController()
    const events: Parameters<typeof acquired>[2] = []
    const claude = fakeClaude({
      replayUuid: 'turn-1',
      routes: {
        interrupt: () => {
          controller.abort()
          throw new ClaudeControlRequestError('interrupt', 'not running')
        }
      }
    })
    const adapter = await acquired(claude, {}, events)
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    const pending = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-1', 'tool-1', {
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-approval', 'permission-1')

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        promptItemId: 'journal-approval',
        promptCancellationId: 'prompt-cancel:operation-1'
      })
    ).resolves.toEqual({ cancelled: true })
    await expect(pending.promise).resolves.toBeNull()
    expect(events.at(-1)).toMatchObject({
      type: 'prompt-cancelled',
      promptKey: 'permission-1',
      settlementId: 'prompt-cancel:operation-1'
    })
  })

  it("admits a dispatch on the write and names it from Claude's replay", async () => {
    const claude = fakeClaude({ replayUuid: 'user-provider-uuid' })
    const settled = vi.fn()
    const adapter = await acquired(claude, {}, [], settled)

    const result = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(result).toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        uuid: 'user-provider-uuid'
      }
    })
    expect(claude.connections[0].sent[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] },
      session_id: PROVIDER_SESSION_ID
    })
  })

  it('does not put delivery in doubt while no replay uuid has arrived', async () => {
    const settled = vi.fn()
    const adapter = await acquired(fakeClaude({ replayUuid: null }), {}, [], settled)
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(settled).not.toHaveBeenCalled()
  })

  it('puts delivery in doubt only when the write itself fails', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const adapter = await acquired(claude)
    claude.connections[0]!.send = async () => {
      throw claudeUnwrittenUserMessageError(new Error('broken pipe'))
    }
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'unknown', reason: 'provider_write_failed: broken pipe' })
  })

  it('requires an acknowledged interrupt and supports controlled options', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'sonnet', fence: 7 })
    ).resolves.toEqual({ model: 'sonnet' })
    expect(claude.connections[0].calls.slice(-2)).toEqual([
      { subtype: 'interrupt', params: {} },
      { subtype: 'set_model', params: { model: 'sonnet' } }
    ])

    claude.routes.interrupt = () => {
      throw new ClaudeControlRequestError('interrupt', 'not running')
    }
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-2', fence: 7 })
    ).resolves.toEqual({ cancelled: false })

    claude.routes.interrupt = () => {
      throw new Error('claude interrupt request timed out')
    }
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-3', fence: 7 })
    ).rejects.toThrow('timed out')
  })

  it('does not let a delayed cancellation for an earlier turn interrupt the later turn', async () => {
    const claude = fakeClaude({ replayUuids: ['turn-T', 'turn-U'] })
    const adapter = await acquired(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-T',
      body: USER_MESSAGE,
      fence: 7
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-U',
      body: USER_MESSAGE,
      fence: 7
    })

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-T', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(claude.connections[0].calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(
      0
    )

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-U', fence: 6 })
    ).resolves.toEqual({ cancelled: false })

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-U', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(claude.connections[0].calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(
      1
    )
  })

  it('does not cancel an acknowledged turn after a later dispatch is still unacknowledged', async () => {
    const claude = fakeClaude({ replayUuids: ['turn-T', null] })
    const settled = vi.fn()
    const adapter = await acquired(claude, {}, [], settled)

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-T',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-T',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: 'turn-T' }
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-U',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(claude.connections[0].sent).toHaveLength(2)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-T', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(claude.connections[0].calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(
      0
    )
  })

  it('classifies provider-declined options without treating timeouts as settled', async () => {
    const claude = fakeClaude({
      routes: {
        set_model: () => {
          throw new ClaudeControlRequestError('set_model', 'model unavailable')
        }
      }
    })
    const adapter = await acquired(claude)

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'fable', fence: 7 })
    ).rejects.toMatchObject({ name: 'AgentSessionOptionRejectedError' })
    claude.routes.set_model = () => {
      throw new Error('claude set_model request timed out')
    }
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    ).rejects.toThrow('timed out')
  })

  it('hydrates live model choices and maps the resolved current model to its CLI id', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: {
        list_models: () => [
          { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default' },
          {
            value: 'opus',
            resolvedModel: 'claude-opus-5',
            displayName: 'Opus',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high']
          },
          {
            value: 'sonnet',
            resolvedModel: 'claude-sonnet-5',
            displayName: 'Sonnet'
          }
        ]
      }
    })
    const adapter = await acquired(claude)

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
      ],
      current: { model: 'sonnet', effort: 'high', confirmed: ['model', 'effort'] }
    })
  })

  it('keeps the shared Claude seed when live model discovery is unavailable', async () => {
    const claude = fakeClaude({
      initModel: 'custom-model',
      routes: {
        list_models: () => {
          throw new Error('unsupported')
        }
      }
    })
    const adapter = await acquired(claude)
    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })

    expect(result.models.map((model) => model.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'custom-model'
    ])
    expect(result.current).toEqual({
      model: 'custom-model',
      effort: 'high',
      confirmed: ['model', 'effort']
    })
  })
})
