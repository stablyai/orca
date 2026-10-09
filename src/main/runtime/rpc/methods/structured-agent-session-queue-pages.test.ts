import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AGENT_SESSION_QUEUE_PAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  openStream,
  SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

it('advertises queue reads independently of person-typed queueing', () => {
  expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_QUEUE_PAGES_RUNTIME_CAPABILITY)
  expect(RUNTIME_CAPABILITIES).not.toContain(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY)
})

it.each([
  {
    method: 'agentSession.queuedMessagesPage',
    host: 'queuedMessagesPage',
    params: { sessionId: SESSION, source: 'person', size: 900 }
  },
  {
    method: 'agentSession.queuedMessageRead',
    host: 'queuedMessageRead',
    params: { sessionId: SESSION, messageId: 'draft', expectedState: 'waiting' }
  }
])(
  'registers and mobile-allowlists $method behind the structured gate',
  async ({ method, host, params }) => {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has(method)).toBe(true)
    expect(
      await call(method, params, { clientKind: 'runtime', clientCapabilities: [] })
    ).toMatchObject({ ok: false, error: { message: 'structured_agent_session_unsupported' } })
    expect(hostCalls[host]).not.toHaveBeenCalled()
    expect(await call(method, params, STRUCTURED_MOBILE_CLIENT)).toMatchObject({ ok: true })
    expect(hostCalls[host]).toHaveBeenCalledWith(params, {
      id: 'request-1',
      runtimeId: 'runtime-1'
    })
  }
)

it.each([
  ['agentSession.queuedMessagesPage', { sessionId: SESSION, size: 0 }],
  ['agentSession.queuedMessagesPage', { sessionId: SESSION, source: 'future' }],
  [
    'agentSession.queuedMessagesPage',
    { sessionId: SESSION, cursor: 'cursor', aroundMessageId: 'anchor' }
  ],
  ['agentSession.queuedMessagesPage', { sessionId: SESSION, extra: true }],
  [
    'agentSession.queuedMessageRead',
    { sessionId: SESSION, messageId: 'draft', expectedState: 'dispatched' }
  ],
  ['agentSession.queuedMessageRead', { sessionId: SESSION, messageId: 'draft', extra: true }],
  ['agentSession.history', { sessionId: SESSION, direction: 'tail', queueView: 'future' }],
  ['agentSession.subscribe', { sessionId: SESSION, queueView: 'future' }]
])('keeps %s params strict', async (method, params) => {
  expect(await call(method, params, STRUCTURED_CLIENT)).toMatchObject({
    ok: false,
    error: { code: 'invalid_argument' }
  })
})

it('passes the explicit queue view to history and subscription, including trusted local calls', async () => {
  const params = { sessionId: SESSION, direction: 'tail', queueView: 'paged-v1' }
  expect(await call('agentSession.history', params)).toMatchObject({ ok: true })
  expect(hostCalls.history).toHaveBeenCalledWith(params)
  await openStream(
    'agentSession.subscribe',
    { sessionId: SESSION, queueView: 'paged-v1' },
    STRUCTURED_CLIENT
  )
  expect(hostCalls.subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ queueView: 'paged-v1' })
  )
})
