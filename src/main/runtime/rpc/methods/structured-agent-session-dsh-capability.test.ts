import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DSH_ACP_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import {
  WORK_METHODS,
  CLEANUP_METHODS
} from './structured-agent-session-gate-classification.test-fixture'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
  hostCalls.sessionAgent?.mockReturnValue('dsh-acp')
})
afterEach(clearStructuredHostStub)
const capable = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    DSH_ACP_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ]
}
describe('mixed-version official ACP RPC boundaries', () => {
  it.each([
    ['desktop IPC', DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES],
    ['paired desktop', remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)]
  ] as const)(
    'admits official ACP through the actual %s capability set',
    async (_transport, clientCapabilities) => {
      const params = { worktree: 'id:workspace-1', agent: 'dsh-acp' }
      const client = { ...STRUCTURED_CLIENT, clientCapabilities: [...clientCapabilities] }
      await expect(call('agentSession.createSupport', params, client)).resolves.toMatchObject({
        ok: true,
        result: { supported: true }
      })
      await expect(
        call('agentSession.createSupport', params, {
          ...client,
          clientCapabilities: clientCapabilities.filter(
            (capability) => capability !== DSH_ACP_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
          )
        })
      ).resolves.toMatchObject({ ok: false })
    }
  )

  it.each(
    WORK_METHODS.filter(
      (entry) =>
        ![
          'agentSession.createSupport',
          'agentSession.create',
          'agentSession.subscribeStatus',
          'agentSession.subscribeTurnCompletions',
          'agentSession.modelCatalog',
          'agentSession.hold'
        ].includes(entry.method)
    )
  )(
    'refuses an old client reading or extending the owned DSH session: $method',
    async ({ method, params }) => {
      const response = await call(method, params, STRUCTURED_CLIENT)
      expect(response).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining('structured_agent_session_unsupported')
        }
      })
    }
  )
  it('refuses official create support before contacting an old host client surface', async () => {
    const params = { worktree: 'id:workspace-1', agent: 'dsh-acp' }
    await expect(
      call('agentSession.createSupport', params, STRUCTURED_CLIENT)
    ).resolves.toMatchObject({ ok: false })
    await expect(call('agentSession.createSupport', params, capable)).resolves.toMatchObject({
      ok: true,
      result: { supported: true }
    })
  })
  it.each(CLEANUP_METHODS)(
    'keeps old-client cleanup available: $method',
    async ({ method, params }) => {
      await expect(call(method, params, STRUCTURED_CLIENT)).resolves.toMatchObject({ ok: true })
    }
  )
  it('does not publish an official turn completion to a client without its optional capability', async () => {
    hostCalls.subscribeTurnCompletions = vi.fn(({ emit }) => {
      emit({ type: 'completion', completion: { sessionId: 'session-alpha', turnId: 'dsh-turn' } })
      emit({ type: 'end' })
      return () => undefined
    })
    await expect(
      call('agentSession.subscribeTurnCompletions', null, STRUCTURED_CLIENT)
    ).resolves.toMatchObject({ ok: true, result: { type: 'end' } })
    await expect(
      call('agentSession.subscribeTurnCompletions', null, capable)
    ).resolves.toMatchObject({ ok: true, result: { type: 'completion' } })
  })
})
