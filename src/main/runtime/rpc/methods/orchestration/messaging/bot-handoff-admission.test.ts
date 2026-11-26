import { afterEach, expect, test, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { ORCHESTRATION_SEND_METHODS } from './send-methods'
import {
  closeBotSession,
  DOCS_REQUEST,
  setupBotMail,
  startBotSession
} from './bot-recipient.test-fixture'
import type * as RecipientRouting from './recipient-routing'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'

vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('./bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock('./recipient-routing', async (actual) =>
  (await import('./bot-recipient.test-fixture')).recipientRoutingMock(
    await actual<typeof RecipientRouting>()
  )
)

const harness = createOrchestrationRpcHarness()
const handoff = {
  to: 'bot:docs',
  type: 'handoff',
  chat: 'new',
  subject: 'Review the docs'
}

afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})

test('a paired coordinator gets no Run or mail conversation when its override is refused', async () => {
  const { db, runtime } = harness.setup(false)
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_SEND_METHODS })
  const conversationId = 'peerconv_000000000001'
  const reply = await dispatcher.dispatch(
    {
      id: 'fixture-peer-call',
      authToken: 'fixture',
      method: 'orchestration.send',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationPeerRun: { runId: 'run_example', conversationId, label: 'Fixture' },
      params: { ...handoff, model: 'gpt-5.5' }
    },
    {
      pairedDeviceId: 'fixture-device',
      authenticatedCallerFingerprint: 'fixture-pairing',
      clientKind: 'runtime',
      callerScope: { kind: 'runtime-paired', grants: [] }
    }
  )
  expect({
    reply,
    run: db.getPeerRunForConversation(conversationId),
    conversation: db.getPeerMailConversation(conversationId)
  }).toMatchObject({
    reply: { ok: false, error: { code: 'capability_unsupported' } },
    run: undefined,
    conversation: undefined
  })
})

test.each(['device', 'relay'] as const)(
  'a %s cannot admit a bot handoff with launch choices',
  async (transport) => {
    const { db, runtime } = setupBotMail(harness)
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: ORCHESTRATION_SEND_METHODS,
      ...(transport === 'relay' ? { callerScope: { kind: 'runtime-paired', grants: [] } } : {})
    })
    const send = (params: typeof handoff & { model?: string }) =>
      dispatcher.dispatch(
        {
          id: 'fixture-call',
          authToken: 'fixture',
          method: 'orchestration.send',
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          params: { ...params, callerScope: { kind: 'owner' } }
        },
        transport === 'device' ? { pairedDeviceId: 'fixture-device' } : undefined
      )

    const refused = await send({ ...handoff, model: 'gpt-5.5' })
    expect({
      refused,
      requestCount: db.db.prepare('SELECT COUNT(*) AS count FROM bot_requests').get()
    }).toMatchObject({
      refused: { ok: false, error: { code: 'capability_unsupported' } },
      requestCount: { count: 0 }
    })
    expect(await send(handoff)).toMatchObject({
      ok: true,
      result: { message: { subject: handoff.subject } }
    })
  }
)

test('switching the receiving agent during creation releases the request and closes the unused chat', async () => {
  const { db, runtime, bots } = setupBotMail(harness)
  const created = Promise.withResolvers<void>()
  const admit = Promise.withResolvers<void>()
  const openChats = new Set<string>()
  startBotSession.mockImplementationOnce(async () => {
    openChats.add(DOCS_REQUEST)
    created.resolve()
    await admit.promise
    return DOCS_REQUEST
  })
  closeBotSession.mockImplementationOnce(async (id) => ({ stopped: openChats.delete(id) }))

  const send = (params: typeof handoff & { model?: string }) =>
    harness.call('orchestration.send', params, { runtime })
  const outcome = send({ ...handoff, model: 'gpt-5.5' }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error })
  )
  await Promise.race([created.promise, outcome])
  const reservation = db.db.prepare('SELECT message_id FROM bot_requests').get()
  bots[1] = { ...bots[1]!, agent: 'claude' }
  admit.resolve()
  expect({
    outcome: await outcome,
    reservation,
    openChats: [...openChats],
    requests: db.db.prepare('SELECT message_id FROM bot_requests').all(),
    messages: db.db.prepare('SELECT id FROM messages').all()
  }).toMatchObject({
    outcome: { error: { code: 'invalid_argument' } },
    reservation: { message_id: expect.any(String) },
    openChats: [],
    requests: [],
    messages: []
  })
  expect(await send(handoff)).toMatchObject({ message: { subject: handoff.subject } })
})
