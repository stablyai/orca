import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../../../shared/agent-session-current-requests-capability'
import { RpcDispatcher } from '../dispatcher'
import type { RpcContext } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'
import { STRUCTURED_AGENT_SESSION_CURRENT_REQUESTS_METHODS } from './structured-agent-session-current-requests'
import { MOBILE_AGENT_SESSION_RPC_METHODS } from '../../runtime-rpc/runtime-rpc-mobile-agent-session-methods'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'

const port = vi.hoisted(() => ({
  native: vi.fn(),
  structured: vi.fn(),
  ensure: vi.fn(),
  host: vi.fn()
}))
vi.mock('../../../native-chat/native-chat-current-requests', () => ({
  cancelNativeChatCurrentQuestions: port.native,
  readNativeChatCurrentRequests: vi.fn()
}))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: vi.fn(),
  subscribeNativeChatTranscript: vi.fn()
}))
vi.mock('./structured-agent-session-gate', () => ({ requireInstalledStructuredHost: port.host }))

beforeEach(() => {
  vi.clearAllMocks()
  port.ensure.mockResolvedValue(undefined)
  port.host.mockResolvedValue({ cancelCurrentQuestions: port.structured })
  port.native.mockResolvedValue(undefined)
  port.structured.mockResolvedValue(undefined)
})
function dispatcher() {
  // SAFETY: these explicit method registries read only the runtime ID, source rows and host installer.
  const runtime = {
    getRuntimeId: () => 'host-1',
    getAgentProviderSessionRows: () => [],
    ensureStructuredAgentSessionHost: port.ensure
  } as unknown as RpcContext['runtime']
  return new RpcDispatcher({
    runtime,
    methods: [...NATIVE_CHAT_METHODS, ...STRUCTURED_AGENT_SESSION_CURRENT_REQUESTS_METHODS]
  })
}
const sessionId = '00000000-0000-4000-8000-000000000001'
const params = {
  sessionId,
  ids: ['displayed-Q1'],
  agent: 'codex',
  transcriptPath: '/host/rollout.jsonl'
}
const options = {
  clientKind: 'mobile' as const,
  clientCapabilities: [AGENT_SESSION_CURRENT_REQUESTS_V2],
  pairedDeviceId: 'phone-1',
  callerScope: { kind: 'mobile' as const }
}
it('routes exactly displayed IDs with transport-proven caller through both phone-authorized Cancel adapters', async () => {
  const rpc = dispatcher()
  const native = await rpc.dispatch(
    { id: 'n', authToken: 'not-an-identity', method: 'nativeChat.cancelCurrentQuestions', params },
    options
  )
  expect(native).toMatchObject({ ok: true, result: { cancelled: true } })
  expect(port.native).toHaveBeenCalledWith(params, 'phone-1', expect.any(AbortSignal))
  const structured = await rpc.dispatch(
    {
      id: 's',
      authToken: 'not-an-identity',
      method: 'agentSession.cancelCurrentQuestions',
      params: { sessionId, ids: params.ids }
    },
    options
  )
  expect(structured).toMatchObject({ ok: true, result: { cancelled: true } })
  expect(port.structured).toHaveBeenCalledWith({ sessionId, ids: ['displayed-Q1'] }, 'phone-1')
  expect(MOBILE_AGENT_SESSION_RPC_METHODS).toContain('agentSession.cancelCurrentQuestions')
  expect(MOBILE_RPC_METHOD_ALLOWLIST.has('nativeChat.cancelCurrentQuestions')).toBe(true)
  expect(
    NATIVE_CHAT_METHODS.find((method) => method.name === 'nativeChat.cancelCurrentQuestions')
      ?.permission
  ).toBe('workspace')
  expect(
    STRUCTURED_AGENT_SESSION_CURRENT_REQUESTS_METHODS.find(
      (method) => method.name === 'agentSession.cancelCurrentQuestions'
    )?.permission
  ).toBe('workspace')
})
it.each(['nativeChat.cancelCurrentQuestions', 'agentSession.cancelCurrentQuestions'])(
  'refuses unnegotiated or unauthenticated %s before touching a source',
  async (method) => {
    const rpc = dispatcher()
    const input = method.startsWith('native') ? params : { sessionId, ids: params.ids }
    for (const transport of [
      { ...options, clientCapabilities: [] },
      { ...options, pairedDeviceId: undefined, clientId: 'forged-device-name' }
    ]) {
      const response = await rpc.dispatch(
        { id: 'refused', authToken: 'not-an-identity', method, params: input },
        transport
      )
      expect(response.ok).toBe(false)
    }
    expect(port.ensure).not.toHaveBeenCalled()
    expect(port.host).not.toHaveBeenCalled()
    expect(port.native).not.toHaveBeenCalled()
    expect(port.structured).not.toHaveBeenCalled()
  }
)
it('rejects wire-injected ownership and returns failed persistence instead of claiming Cancel succeeded', async () => {
  const rpc = dispatcher()
  const rejected = await rpc.dispatch(
    {
      id: 'bad',
      authToken: '',
      method: 'nativeChat.cancelCurrentQuestions',
      params: { ...params, caller: 'victim' }
    },
    options
  )
  expect(rejected).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  expect(port.native).not.toHaveBeenCalled()
  port.native.mockRejectedValueOnce(new Error('commit failed'))
  const failed = await rpc.dispatch(
    { id: 'fail', authToken: '', method: 'nativeChat.cancelCurrentQuestions', params },
    options
  )
  expect(failed.ok).toBe(false)
})
