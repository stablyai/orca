import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { describe, expect, it, vi } from 'vitest'
import {
  acquired,
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  USER_MESSAGE
} from '../claude-structured-session-test-support'
import * as dispatchContent from '../claude-structured-dispatch-content'
import { ClaudeControlRequestError } from '../../claude-agent-sdk-control-requests'
import { claudeStructuredPermissionOptions } from './claude-structured-launch-resolution'

/** Claude ends a turn; a message sent before this joins the running turn on its choices. */
const claudeTurnEnds = (connection: Parameters<typeof claudeFrame>[0]) =>
  claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })

const MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-5' },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  }
]

it('checks the latest permission after model preparation without admitting a stale frame', async () => {
  const claude = fakeClaude()
  const adapter = adapterFor(claude)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'permission-race',
    events: recordingJournalSink()
  })
  const connection = claude.connections[0]!
  claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-sonnet-5' })
  const preparing = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  connection.setModel = async () => {
    preparing.resolve()
    await resume.promise
  }
  let changed = false
  const admitted = vi.fn()
  const sending = adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'permission-race',
    body: USER_MESSAGE,
    executionOptions: { model: 'custom[1m]' },
    fence: 7,
    admitFreshInput: async (enqueue) =>
      changed ? { kind: 'acquire', reason: 'permission' } : enqueue('ask', false)
  })
  const result = sending.then(admitted, (error) => error)
  await preparing.promise
  changed = true
  resume.resolve()
  expect(await result).toBeInstanceOf(StructuredAgentSessionInputNotAdmitted)
  expect(admitted).not.toHaveBeenCalled()
  expect(connection.sent).toHaveLength(0)
  await adapter.closeAll()
})

describe('Claude accepted message choices', () => {
  // --effort arrived in Claude Code 2.1.38 and the live control in 2.1.50; older CLIs reject the flag
  // and never answer the control, so either one failed every resume of a chat with a saved effort.

  it('applies a held message A before its prompt, then message B on the existing child', async () => {
    const order: string[] = []
    let currentEffort = 'high'
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        set_model: ({ model } = {}) => order.push(`model:${String(model)}`),
        apply_flag_settings: ({ settings } = {}) => {
          order.push(`effort:${JSON.stringify(settings)}`)
          if (
            typeof settings === 'object' &&
            settings !== null &&
            'effortLevel' in settings &&
            typeof settings.effortLevel === 'string'
          ) {
            currentEffort = settings.effortLevel
          }
        }
      }
    })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]!
    connection.getSettings = async () => ({ effective: { effortLevel: currentEffort } })
    const send = connection.send
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredSend = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    connection.send = async (message, beforeDispatch) => {
      if (first) {
        first = false
        entered()
        await held
      }
      const result = await send(message, beforeDispatch)
      order.push('prompt')
      return result
    }

    const a = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'A',
      body: USER_MESSAGE,
      executionOptions: { model: 'sonnet', effort: 'low' },
      fence: 7
    })
    await enteredSend
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    order.length = 0
    release()
    await expect(a).resolves.toMatchObject({ state: 'admitted' })
    expect(order).toEqual(['model:sonnet', 'effort:{"effortLevel":"low"}', 'prompt'])
    claudeTurnEnds(connection)

    order.length = 0
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'B',
        body: USER_MESSAGE,
        executionOptions: { model: 'opus', effort: 'high' },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(order).toEqual(['model:opus', 'effort:{"effortLevel":"high"}', 'prompt'])
  })

  // Host admission treats the original abort as never written.
  it('surfaces a Stop while it applies a choice as the abort, and a refusal as a refusal', async () => {
    let refuse = false
    const claude = fakeClaude({
      initModels: MODELS,
      routes: {
        list_models: () => MODELS,
        set_model: () => {
          if (refuse) {
            throw new ClaudeControlRequestError('set_model', 'unknown model')
          }
          return new Promise(() => {})
        }
      }
    })
    const adapter = await acquired(claude)
    const stop = new AbortController()
    const dispatch = (clientMessageId: string, signal?: AbortSignal) =>
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId,
        body: USER_MESSAGE,
        executionOptions: { model: 'opus' },
        fence: 7,
        ...(signal ? { signal } : {})
      })
    const stopped = dispatch('stopped', stop.signal)
    await vi.waitFor(() =>
      expect(claude.connections[0]!.calls.some((call) => call.subtype === 'set_model')).toBe(true)
    )
    stop.abort(new Error('stopped while starting'))
    await expect(stopped).rejects.toBe(stop.signal.reason)
    refuse = true
    await expect(dispatch('refused')).resolves.toMatchObject({
      state: 'rejected',
      rejection: { kind: 'providerRejected' }
    })
    expect(claude.connections[0]!.sent).toHaveLength(0)
  })

  it('keeps a running turn on its choices and applies new ones at the next turn', async () => {
    const claude = fakeClaude({
      initModels: MODELS.map((model) => ({ ...model, supportsFastMode: true })),
      routes: { list_models: () => MODELS }
    })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]!
    const send = (clientMessageId: string, model: string, body = USER_MESSAGE) =>
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId,
        body,
        executionOptions: {
          model,
          effort: model === 'sonnet' ? 'high' : 'low',
          fastMode: model === 'sonnet' ? 'false' : 'true'
        },
        fence: 7
      })
    const models = () =>
      connection.calls.flatMap((call) => (call.subtype === 'set_model' ? [call.params?.model] : []))
    await expect(send('opens', 'sonnet')).resolves.toMatchObject({ state: 'admitted' })
    expect(models()).toEqual(['sonnet'])
    const settings = () => connection.calls.filter((call) => call.subtype === 'apply_flag_settings')
    const liveSettings = [...settings()]
    // Typed while that turn runs, after the pick changed: it joins the turn as it is.
    await expect(send('joins', 'opus')).resolves.toMatchObject({ state: 'admitted' })
    expect(models()).toEqual(['sonnet'])
    expect(settings()).toEqual(liveSettings)
    claudeTurnEnds(connection)
    const mail = {
      ...USER_MESSAGE,
      from: {
        kind: 'agent' as const,
        senders: [],
        orchestration: {
          message: 'mail-notice' as const,
          mailbox: 'agent:worker',
          dispatchId: null,
          messages: []
        }
      }
    }
    await expect(send('mail', 'opus', mail)).resolves.toMatchObject({ state: 'admitted' })
    expect(models()).toEqual(['sonnet'])
    expect(settings()).toEqual(liveSettings)
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const original = dispatchContent.claudeDispatchMessageContent
    const content = vi
      .spyOn(dispatchContent, 'claudeDispatchMessageContent')
      .mockImplementationOnce(async (body) => {
        entered.resolve()
        await held.promise
        return original(body)
      })
    const delayed = send('next', 'opus')
    try {
      await entered.promise
      claudeTurnEnds(connection)
      held.resolve()
      await expect(delayed).resolves.toMatchObject({ state: 'admitted' })
    } finally {
      held.resolve()
      content.mockRestore()
    }
    expect(models()).toEqual(['sonnet', 'opus'])
    expect(settings()).toContainEqual({
      subtype: 'apply_flag_settings',
      params: { settings: { effortLevel: 'low' } }
    })
    expect(settings()).toContainEqual({
      subtype: 'apply_flag_settings',
      params: { settings: { fastMode: true } }
    })
    expect(connection.sent).toHaveLength(4)
    claudeTurnEnds(connection)
    const settingsAfterTurn = [...settings()]
    const originalSend = connection.send
    connection.send = async (message, prepare) => {
      await prepare?.()
      connection.sent.push(message)
    }
    try {
      await expect(send('starts', 'opus')).resolves.toMatchObject({ state: 'admitted' })
      expect(models()).toEqual(['sonnet', 'opus', 'opus'])
      expect(settings()).toEqual([
        ...settingsAfterTurn,
        { subtype: 'apply_flag_settings', params: { settings: { effortLevel: 'low' } } },
        { subtype: 'apply_flag_settings', params: { settings: { fastMode: true } } }
      ])
      const settingsAtStart = [...settings()]
      claudeFrame(connection, {
        type: 'command_lifecycle',
        state: 'started',
        command_uuid: connection.sent.at(-1)?.uuid
      })
      await expect(send('before-echo', 'sonnet')).resolves.toMatchObject({ state: 'admitted' })
      expect(models()).toEqual(['sonnet', 'opus', 'opus'])
      expect(settings()).toEqual(settingsAtStart)
    } finally {
      connection.send = originalSend
      await adapter.closeAll()
    }
  })
})

it('applies explicit planning at fresh turns, preserves startup permission fallback, and leaves steers alone', async () => {
  const claude = fakeClaude({ initPermissionMode: 'default' })
  const adapter = await acquired(claude, {
    options: claudeStructuredPermissionOptions('full-access')
  })
  const connection = claude.connections[0]!
  claudeFrame(connection, {
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-5-5',
    permissionMode: 'default'
  })
  const setMode = vi.spyOn(connection, 'setPermissionMode').mockResolvedValue(undefined)
  const send = (id: string, mode?: 'plan' | 'default') =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      body: USER_MESSAGE,
      fence: 7,
      executionOptions: mode ? { interactionMode: mode } : {}
    })
  await send('own')
  expect(setMode).not.toHaveBeenCalled()
  claudeTurnEnds(connection)
  await send('plan', 'plan')
  expect(setMode).toHaveBeenLastCalledWith('plan', { timeoutMs: undefined })
  await send('steer', 'default')
  expect(setMode).toHaveBeenCalledTimes(1)
  claudeTurnEnds(connection)
  await send('build', 'default')
  expect(setMode).toHaveBeenLastCalledWith('default', { timeoutMs: undefined })
  claudeTurnEnds(connection)
  claudeFrame(connection, { type: 'system', subtype: 'status', permissionMode: 'plan' })
  await send('build-again', 'default')
  expect(setMode).toHaveBeenCalledTimes(3)
  await adapter.closeAll()
})
