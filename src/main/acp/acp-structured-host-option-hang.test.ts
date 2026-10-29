import { structuredAgentSessionHandingOver } from '../native-chat/agent-session-wire/structured-agent-session-handing-over'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { GROK_CONFIG_OPTIONS, waitFor } from './acp-structured-adapter.test-support'
import {
  framesOf,
  hello,
  openAttachedHostRig,
  send,
  stop
} from './acp-structured-host.test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { STOP_NOTE_CANCELLATION_REQUESTED } from '../native-chat/agent-session-wire/structured-agent-session-turn-stop-notes'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

function pick(host: StructuredAgentSessionHost, value: string) {
  const fields = { key: 'model', value }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

describe('a Grok model pick Grok never answers during send', () => {
  it('does not hold Stop, writes one request note, and ignores a late setter reply', async () => {
    const { rig, host, rows } = await openAttachedHostRig({
      script: (agent) => agent.on('session/set_config_option', () => {})
    })
    expect(await pick(host, 'grok-4.6')).toMatchObject({ ok: true })
    await send(host, 'hello')
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(1))
    const invalid = host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', {}, { payloadFingerprint: 'invalid' })
    })
    // Stop bypasses the session queue even while an option write stalls.
    await expect(invalid).resolves.toMatchObject({ ok: false })
    const request = { envelope: envelope('agentSession.cancel', {}) }
    await expect(host.cancel(CALLER, request)).resolves.toMatchObject({ ok: true })
    expect(await invalid).toMatchObject({ ok: false })
    expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
    expect(
      host.collaboratorsForTests().sessions.get(SESSION)?.journal.submissions()[0]?.dispatchState
    ).toBe('rejected')
    expect(
      (await rows()).filter(
        (row) => row.body.kind === 'status' && row.body.text === STOP_NOTE_CANCELLATION_REQUESTED
      )
    ).toHaveLength(1)
    const [frame] = framesOf(rig.child(), 'session/set_config_option')
    rig.child().agent.reply(frame!, { configOptions: GROK_CONFIG_OPTIONS })
    expect(framesOf(rig.child(), 'session/prompt')).toEqual([])
    await expect(host.close(SESSION, 'user-close')).resolves.toBeUndefined()
  })

  it('does not hold a Close behind its write', async () => {
    const { rig, host } = await openAttachedHostRig({
      script: (agent) => agent.on('session/set_config_option', () => {})
    })
    expect(await pick(host, 'grok-4.6')).toMatchObject({ ok: true })
    const dispatch = vi.spyOn(rig.adapter, 'dispatch')
    const sending = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: hello }),
      body: hello,
      userSend: true
    })
    if (!sending.ok) {
      throw new Error(JSON.stringify(sending.refusal))
    }
    const id = sending.value.clientMessageId
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(1))
    const original = structuredAgentSessionHandingOver(journal).get(id)?.input
    await expect(host.close(SESSION, 'user-close')).resolves.toBeUndefined()
    await original?.finalization.completion
    await Promise.allSettled(dispatch.mock.results.map((result) => result.value))
    const [frame] = framesOf(rig.child(), 'session/set_config_option')
    rig.child().agent.reply(frame!, { configOptions: GROK_CONFIG_OPTIONS })
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    await journal['queue'].drain()
    expect(framesOf(rig.child(), 'session/prompt')).toEqual([])
    expect(original).toBeDefined()
    expect(structuredAgentSessionHandingOver(journal).has(id)).toBe(false)
    expect(journal.queuedMessages.list()).toMatchObject([
      { messageId: id, body: { blocks: [{ text: 'hello' }] } }
    ])
    expect(journal.submission(id)).toMatchObject({
      keptAsQueuedMessageId: id,
      rejection: { kind: 'chatClosed' }
    })
  })

  it('re-establishes opening A after uncertain B without adopting B’s late reply', async () => {
    const { rig, host, store, fence } = await openAttachedHostRig({
      optionWriteTimeoutMs: 100,
      script: (agent) => agent.on('session/set_config_option', () => {})
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(await pick(host, 'grok-4.6')).toMatchObject({ ok: true })
    const savedModel = store.getRecord(SESSION)?.options?.model
    expect(savedModel).toBe('grok-4.6')
    await send(host, 'hello')
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(100)
    await waitFor(() =>
      expect(
        host.collaboratorsForTests().sessions.get(SESSION)?.journal.submissions()[0]?.dispatchState
      ).toBe('rejected')
    )
    vi.useRealTimers()
    expect(framesOf(rig.child(), 'session/prompt')).toEqual([])
    await expect(host.readOptions(SESSION)).resolves.toMatchObject({
      current: { model: savedModel }
    })
    const restore = rig.adapter.dispatch({
      sessionId: SESSION,
      fence: fence(),
      clientMessageId: 'restore-A',
      executionOptions: { model: 'grok-4.7' },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'A again' }] }
    })
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(2))
    const [old, current] = framesOf(rig.child(), 'session/set_config_option')
    rig.child().agent.reply(current!, { configOptions: GROK_CONFIG_OPTIONS })
    await restore
    expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(2)
    expect([old?.params, current?.params]).toEqual([
      { sessionId: expect.any(String), configId: 'model', value: 'grok-4.6' },
      { sessionId: expect.any(String), configId: 'model', value: 'grok-4.7' }
    ])
    expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
    rig.child().agent.reply(old!, {
      configOptions: GROK_CONFIG_OPTIONS.map((option) =>
        option.id === 'model' ? { ...option, currentValue: 'grok-4.6' } : option
      )
    })
    await rig.settle()
    expect(
      (await rig.adapter.readOptions({ sessionId: SESSION, fence: fence() })).current.model
    ).toBe('grok-4.7')
    expect((await host.readOptions(SESSION)).current.model).toBe(savedModel)
    expect(store.getRecord(SESSION)?.options?.model).toBe(savedModel)
    await host.close(SESSION, 'user-close')
  })
})

describe('a saved Grok pick', () => {
  it.each(['Stop', 'Close'] as const)(
    'never contacts Grok or holds %s behind a setter',
    async (ending) => {
      const { rig, host, store } = await openAttachedHostRig({
        script: (agent) => agent.on('session/set_config_option', () => {})
      })
      await expect(pick(host, 'grok-4.6')).resolves.toMatchObject({ ok: true })
      expect(store.getRecord(SESSION)?.options?.model).toBe('grok-4.6')
      expect(framesOf(rig.child(), 'session/set_config_option')).toEqual([])
      const ended = ending === 'Stop' ? stop(host) : host.close(SESSION, 'user-close')
      await ended
      await host.close(SESSION, 'user-close')
    }
  )
})
