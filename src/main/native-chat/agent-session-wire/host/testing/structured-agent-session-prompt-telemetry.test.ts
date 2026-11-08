import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../../runtime/rpc/core'
import type { RpcCallerIdentity } from '../../../../runtime/rpc/rpc-caller-identity'
import { structuredCallerFor } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import { track } from '../../../../telemetry/client'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage,
  hostTestOperationId,
  hostTestSendParams
} from './structured-agent-session-host-test-data'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))

let rig: QueuedMessageTestRig
const prompts = () =>
  vi.mocked(track).mock.calls.filter(([name]) => name === 'native_chat_prompt_submitted')

function transportCaller(caller?: RpcCallerIdentity, clientKind?: 'mobile' | 'runtime') {
  const context: Partial<RpcContext> = { caller, clientKind }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: caller derivation reads only transport identity fields supplied here.
  return structuredCallerFor(context as RpcContext)
}
const desktop = () => transportCaller({ kind: 'desktop' })

beforeEach(async () => {
  vi.clearAllMocks()
  rig = await createQueuedMessageTestRig()
})
afterEach(async () => rig.dispose())

it('counts a desktop prompt at provider acceptance, excluding handover, rejection and replay', async () => {
  const rejected = { ...hostTestSendParams('private rejected prompt'), userSend: true as const }
  await rig.host.send(desktop(), rejected)
  const refused = rejected.envelope.clientOperationId
  await eventually(async () => expect((await rig.submission(refused))?.handedOverAt).toBeDefined())
  expect(prompts()).toEqual([])
  await rig.settleRejected(refused, 'Provider refused this prompt')
  expect(prompts()).toEqual([])

  const params = { ...hostTestSendParams('private accepted prompt'), userSend: true as const }
  await rig.host.send(desktop(), params)
  await eventually(async () =>
    expect((await rig.submission(params.envelope.clientOperationId))?.handedOverAt).toBeDefined()
  )
  expect(prompts()).toEqual([])
  await rig.settleAccepted(params.envelope.clientOperationId, 'accepted-desktop')
  const expected = [
    ['native_chat_prompt_submitted', { agent_kind: 'codex', runtime: 'unknown', client: 'desktop' }]
  ]
  expect(prompts()).toEqual(expected)

  await rig.host.send(desktop(), params)
  expect(prompts()).toEqual(expected)
})

it('keeps the phone provenance through automatic queued handoff and ignores withdrawn cards', async () => {
  const working = await rig.workingSend()
  const caller = transportCaller({ kind: 'paired-device', deviceId: 'phone-1' }, 'mobile')
  const queue = async (text: string) => {
    const id = hostTestOperationId()
    const fields = { body: hostTestMessage(text), delivery: 'queue-if-active' as const }
    const answer = await rig.host.send(caller, {
      envelope: rig.envelope(fields, 'agentSession.send', id),
      ...fields,
      userSend: true
    })
    expect(answer).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    return id
  }
  const withdrawn = await queue('private withdrawn phone prompt')
  await rig.deleteQueued(withdrawn)
  const waiting = await queue('private queued phone prompt')
  expect(prompts()).toEqual([])

  await rig.settleRejected(working, 'End the earlier request without accepting it')
  await eventually(async () => expect((await rig.handoff(waiting))?.handedOverAt).toBeDefined())
  expect(prompts()).toEqual([])
  const handedOver = await rig.handoffId(waiting)
  await rig.settleAccepted(handedOver, 'accepted-phone')
  expect(prompts()).toEqual([
    ['native_chat_prompt_submitted', { agent_kind: 'codex', runtime: 'unknown', client: 'mobile' }]
  ])
  expect((await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })).ok).toBe(
    true
  )
  expect(prompts()).toEqual([
    ['native_chat_prompt_submitted', { agent_kind: 'codex', runtime: 'unknown', client: 'mobile' }]
  ])
})

it('does not treat provider-accepted commands or internal messages as user prompts', async () => {
  const fields = { command: 'compact' as const }
  const commandId = hostTestOperationId()
  expect(
    await rig.host.conversationCommand(desktop(), {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', commandId),
      ...fields
    })
  ).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(
      ((await rig.submission(commandId)) ?? (await rig.handoff(commandId)))?.dispatchState
    ).toBe('accepted')
  )
  rig.finishCompact()
  expect(prompts()).toEqual([])

  const internal = rig.send('private unattended agent message', undefined, { internal: true })
  await internal.result
  await eventually(async () =>
    expect((await rig.submission(internal.id))?.handedOverAt).toBeDefined()
  )
  await rig.settleAccepted(internal.id, 'accepted-internal')
  expect(prompts()).toEqual([])
})

it('excludes CLI and unproven runtime callers even when their send uses userSend', async () => {
  for (const caller of [
    transportCaller({ kind: 'local-cli' }),
    transportCaller({ kind: 'local-cli' }, 'runtime'),
    transportCaller(undefined, 'runtime'),
    transportCaller()
  ]) {
    const params = { ...hostTestSendParams('private automated prompt'), userSend: true as const }
    await rig.host.send(caller, params)
    await eventually(async () =>
      expect((await rig.submission(params.envelope.clientOperationId))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(params.envelope.clientOperationId, params.envelope.clientOperationId)
  }
  expect(prompts()).toEqual([])
})

it('counts the trusted desktop opening message only after its provider accepts it', async () => {
  const sessionId = 'new-chat-with-first-prompt'
  const firstMessage = {
    clientMessageId: hostTestOperationId(),
    body: hostTestMessage('private opening prompt')
  }
  const params = createTestParams(firstMessage, {}, sessionId)
  expect(await rig.host.create(desktop(), params, { firstMessage })).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(
      (await rig.host.journalSnapshot(sessionId)).submissions.find(
        (entry) => entry.clientMessageId === firstMessage.clientMessageId
      )?.handedOverAt
    ).toBeDefined()
  )
  expect(prompts()).toEqual([])
  await rig.host.settleLateDispatch({
    sessionId,
    clientMessageId: firstMessage.clientMessageId,
    providerIdentity: {
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: 'opening-turn',
      ordinal: 0
    }
  })
  expect(prompts()).toEqual([
    ['native_chat_prompt_submitted', { agent_kind: 'codex', runtime: 'unknown', client: 'desktop' }]
  ])
})
