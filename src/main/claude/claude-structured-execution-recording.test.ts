import { expect, it } from 'vitest'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import { recordAgentSessionRanOptions } from '../runtime/agent-session-record-options'
import {
  createQueuedMessageTestRig,
  eventually
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

/** Claude ends a turn; a message sent before this joins the running turn on its choices. */
const claudeTurnEnds = (connection: Parameters<typeof claudeFrame>[0]) =>
  claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })

it.each(['low', 'high', undefined])(
  'admits accepted high independently of resolved effort (effective %s)',
  async (effective) => {
    const models = [
      {
        value: 'sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsFastMode: true
      }
    ]
    const claude = fakeClaude({
      initModels: models,
      routes: { list_models: () => models },
      settings: {
        ...(effective ? { applied: { model: 'sonnet', effort: 'low' } } : {}),
        effective: { effortLevel: effective, fastMode: false }
      }
    })
    const adapter = await acquired(claude)
    const rig = await createQueuedMessageTestRig()
    const choices = { model: 'sonnet', effort: 'high', fastMode: 'true' } as const
    try {
      rig.dispatch.mockImplementation((input) =>
        adapter.dispatch({ ...input, sessionId: 'session-1', fence: 7 })
      )
      const first = rig.send('first', undefined, { carried: choices })
      expect(await first.result).toMatchObject({ ok: true })
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      await eventually(() =>
        expect(rig.store.getRecord(SESSION)?.options).toEqual(
          effective ? { model: 'sonnet', effort: 'low' } : undefined
        )
      )
      const outcome = await rig.dispatch.mock.results[0]!.value
      expect(outcome).toEqual({
        state: 'admitted',
        ranOptions: effective ? { model: 'sonnet', effort: 'low' } : {}
      })
      expect(outcome.ranOptions).not.toHaveProperty('fastMode')
      const record = rig.store.getRecord(SESSION)!
      expect(
        recordAgentSessionRanOptions(
          { ...record, options: { model: 'sonnet', effort: 'high' } },
          {
            sessionId: SESSION,
            fence: record.lease.runtimeFence,
            model: 'sonnet',
            options: outcome.ranOptions!,
            models: undefined,
            now: record.updatedAt
          }
        ).options
      ).toEqual({ model: 'sonnet', effort: 'high' })
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'again',
        body: USER_MESSAGE,
        executionOptions: choices,
        fence: 7
      })
      expect(
        claude.connections[0]!.calls.filter(
          (call) =>
            call.subtype === 'apply_flag_settings' && JSON.stringify(call.params).includes('high')
        )
      ).toHaveLength(1)
      expect(claude.connections[0]!.sent).toHaveLength(2)
    } finally {
      await adapter.closeAll()
      await rig.dispose()
    }
  }
)

it('retires earlier Fast routing when an effort read reports Fast off', async () => {
  let fastMode = true
  const models = [
    {
      value: 'sonnet',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsFastMode: true
    }
  ]
  const claude = fakeClaude({
    initModels: models,
    routes: { list_models: () => models },
    settings: {
      applied: { model: 'sonnet', effort: 'low' },
      get effective() {
        return { effortLevel: 'high', fastMode }
      }
    }
  })
  const adapter = await acquired(claude)
  const send = (effort: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: effort,
      body: USER_MESSAGE,
      executionOptions: { model: 'sonnet', effort, fastMode: 'true' },
      fence: 7
    })
  try {
    await send('high')
    claudeTurnEnds(claude.connections[0]!)
    claudeFrame(claude.connections[0]!, {
      type: 'system',
      subtype: 'status',
      fast_mode_state: 'on'
    })
    fastMode = false
    expect(await send('low')).toMatchObject({ state: 'admitted', ranOptions: { effort: 'low' } })
    claudeTurnEnds(claude.connections[0]!)
    expect(await send('low')).toEqual({ state: 'admitted', ranOptions: { effort: 'low' } })
  } finally {
    await adapter.closeAll()
  }
})

it('never pairs an earlier unknown-model low run with the next prepared model', async () => {
  const applied: { model?: string; effort: string } = { effort: 'low' }
  const claude = fakeClaude({ initModel: '', settings: { applied } })
  const events: Parameters<typeof acquired>[2] = []
  const adapter = await acquired(claude, {}, events)
  const rig = await createQueuedMessageTestRig()
  try {
    rig.dispatch.mockImplementation((input) =>
      adapter.dispatch({ ...input, sessionId: 'session-1', fence: 7 })
    )
    const first = rig.send('first')
    await first.result
    await eventually(async () =>
      expect((await rig.submission(first.id))?.handedOverAt).toBeDefined()
    )
    expect(await rig.dispatch.mock.results[0]!.value).toEqual({
      state: 'admitted',
      ranOptions: { effort: 'low' }
    })
    expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
    await rig.settleAccepted(first.id, 'a')
    claudeTurnEnds(claude.connections[0]!)
    claude.routes.set_model = async () => {
      claudeFrame(claude.connections[0]!, { type: 'system', subtype: 'init', model: 'B' })
      const report = events.findLast((event) => event.type === 'options-reported')!
      await rig.host.handleAdapterEvent({
        ...report,
        sessionId: SESSION,
        fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: 'generation-1'
      })
      expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
      Object.assign(applied, { model: 'B', effort: 'high' })
    }
    await rig.send('second', undefined, { carried: { model: 'B', effort: 'high' } }).result
    await eventually(() =>
      expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'B', effort: 'high' })
    )
    expect(claude.connections[0]!.sent).toHaveLength(2)
  } finally {
    await adapter.closeAll()
    await rig.dispose()
  }
})

it('does not save a deferred model with a live unknown-model turn’s observed effort through handover', async () => {
  // Same partial get_settings shape as the CLI capture: applied effort without model.
  const claude = fakeClaude({
    initModel: '',
    settings: { applied: { effort: 'low' }, effective: { effortLevel: 'low' } }
  })
  const adapter = await acquired(claude)
  const rig = await createQueuedMessageTestRig()
  try {
    rig.dispatch.mockImplementation((input) =>
      adapter.dispatch({ ...input, sessionId: 'session-1', fence: 7 })
    )
    const first = rig.send('open the turn')
    await first.result
    await eventually(async () =>
      expect((await rig.submission(first.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(first.id, 'first')
    const followup = rig.send('keep working', undefined, { carried: { model: 'opus[1m]' } })
    await followup.result
    await eventually(() => expect(claude.connections[0]!.sent).toHaveLength(2))
    await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
    expect(await rig.dispatch.mock.results[1]!.value).toEqual({
      state: 'admitted',
      ranOptions: { effort: 'low' }
    })
    expect(claude.connections[0]!.calls.filter((call) => call.subtype === 'set_model')).toEqual([])
    expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
  } finally {
    await adapter.closeAll()
    await rig.dispose()
  }
})
