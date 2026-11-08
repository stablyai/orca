import { setStructuredAgentSessionHost } from './host/structured-agent-session-registry'
import { sendStructuredAgentSessionForClient } from '../../runtime/rpc/methods/structured-sessions/conversation/structured-agent-session-send-compatibility'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { partialRuntimeStore } from '../../runtime/orca-runtime-tests/runtime-store-partial-fixture'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/agent-session/agent-session-runtime-capabilities'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './host/testing/structured-agent-session-host-test-data'
import { eventually } from './host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { track } from '../../telemetry/client'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../shared/native-chat/native-chat-usage-limit-cut'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  vi.mocked(track).mockClear()
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})
const messages = () =>
  vi.mocked(track).mock.calls.filter(([name]) => name === 'native_chat_message_sent')
const journal = () => rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal

it('counts dispatch acknowledgement rather than admission and keeps the existing live process', async () => {
  const first = await rig.workingSend()
  expect(journal().submission(first)?.chatAction).toBe('message')
  expect(messages()).toHaveLength(0)
  await rig.settleAccepted(first, 'first')
  expect(messages()).toEqual([
    [
      'native_chat_message_sent',
      expect.objectContaining({
        semantics_version: 2,
        action: 'message',
        backend: 'structured',
        outcome: 'transport_acknowledged'
      })
    ]
  ])
  const startsBefore = vi
    .mocked(track)
    .mock.calls.filter(([name]) => name === 'agent_started').length
  const second = rig.send('another human message')
  await second.result
  await eventually(async () =>
    expect((await rig.submission(second.id))?.handedOverAt).toBeDefined()
  )
  expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'agent_started')).toHaveLength(
    startsBefore
  )
  expect(messages()).toHaveLength(1)
  await rig.settleAccepted(second.id, 'second')
  expect(messages()).toHaveLength(2)
})

it.each(['/provider-command', NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE])(
  'preserves %s as a non-message through queue, restart, and explicit handoff',
  async (text) => {
    const first = await rig.workingSend()
    const queued = rig.send(text, 'queue-if-active')
    expect(await queued.result).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    expect(journal().queuedMessages.get(queued.id)?.chatAction).toBe(
      text.startsWith('/') ? 'command' : 'continue'
    )
    await rig.restartHostProcess()
    await rig.settleAccepted(first, 'first')
    vi.mocked(track).mockClear()
    expect(await rig.sendNow(queued.id)).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(queued.id)).toBeDefined())
    const handoff = (await rig.handoff(queued.id))!
    expect(journal().submission(handoff.clientMessageId)?.chatAction).toBe(
      text.startsWith('/') ? 'command' : 'continue'
    )
    await rig.settleAccepted(handoff.clientMessageId, 'command')
    expect(messages()).toHaveLength(0)
  }
)

it('preserves queued human message metadata through reconnect and counts its fresh handoff once', async () => {
  const first = await rig.workingSend()
  const queued = rig.send('queued human question', 'queue-if-active')
  await queued.result
  await rig.restartHostProcess()
  await rig.settleAccepted(first, 'first')
  vi.mocked(track).mockClear()
  expect(await rig.sendNow(queued.id)).toMatchObject({ ok: true })
  const handoff = (await rig.handoff(queued.id))!
  expect(journal().submission(handoff.clientMessageId)?.chatAction).toBe('message')
  expect(messages()).toHaveLength(0)
  await rig.settleAccepted(handoff.clientMessageId, 'queued')
  await rig.settleAccepted(handoff.clientMessageId, 'queued')
  expect(messages()).toHaveLength(1)
})

it('reopening a live session adds no start, while a new process after release is a resume', async () => {
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(rig.starts).toHaveBeenCalledOnce()
  expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'agent_started')).toHaveLength(0)
  const first = await rig.workingSend()
  await rig.settleAccepted(first, 'first')
  await rig.host.close(SESSION, 'evict')
  const next = rig.send('resume this chat')
  await next.result
  await eventually(() => expect(rig.starts).toHaveBeenCalledTimes(2))
  await eventually(() =>
    expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'agent_started')).toEqual([
      [
        'agent_started',
        expect.objectContaining({
          backend: 'structured',
          semantics_version: 2,
          request_kind: 'resume'
        })
      ]
    ])
  )
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'agent_started')).toHaveLength(1)
})

it('carries the human action through automatic queue drain without counting the queue receipt', async () => {
  const first = await rig.workingSend()
  const queued = rig.send('queued question', 'queue-if-active')
  await queued.result
  expect(messages()).toHaveLength(0)
  await rig.settleAccepted(first, 'first')
  await eventually(async () => expect(await rig.handoff(queued.id)).toBeDefined())
  expect(messages()).toHaveLength(1)
  const handoff = (await rig.handoff(queued.id))!
  expect(journal().submission(handoff.clientMessageId)?.chatAction).toBe('message')
  await rig.settleAccepted(handoff.clientMessageId, 'queued')
  expect(messages()).toHaveLength(2)
})

it.each([false, true])(
  'keeps phone sends out of desktop dispatch events (queued: %s)',
  async (queued) => {
    const first = queued ? await rig.workingSend() : null
    vi.mocked(track).mockClear()
    setStructuredAgentSessionHost(rig.host)
    const id = hostTestOperationId()
    const fields = {
      body: hostTestMessage('phone question'),
      ...(queued ? { delivery: 'queue-if-active' as const } : {})
    }
    const params = {
      envelope: rig.envelope(fields, 'agentSession.send', id),
      ...fields
    }
    const context = {
      runtime: new OrcaRuntimeService(partialRuntimeStore()),
      clientKind: 'mobile' as const,
      clientId: 'phone-1',
      clientCapabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
      ]
    }
    expect(await sendStructuredAgentSessionForClient(params, context)).toMatchObject({ ok: true })
    expect(await sendStructuredAgentSessionForClient(params, context)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(messages()).toEqual([
      ['native_chat_message_sent', { agent_kind: 'codex', runtime: 'unknown', client: 'mobile' }]
    ])
    let submissionId = id
    if (first) {
      await rig.restartHostProcess()
      await rig.settleAccepted(first, 'desktop-first')
      expect(await rig.sendNow(id)).toMatchObject({ ok: true })
      await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
      submissionId = (await rig.handoff(id))!.clientMessageId
    } else {
      await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
    }
    vi.mocked(track).mockClear()
    await rig.settleAccepted(submissionId, 'phone-item')
    expect(journal().submission(submissionId)?.dispatchState).toBe('accepted')
    expect(messages()).toEqual([])
  }
)
