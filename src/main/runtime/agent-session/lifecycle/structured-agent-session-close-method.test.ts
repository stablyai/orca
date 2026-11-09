import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from '../../rpc/methods/structured-sessions/conversation/structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_CLOSE_METHOD } from '../../rpc/methods/structured-sessions/conversation/structured-agent-session-close-method'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import {
  AGENT_SESSION_CLOSE_ONLY_CLIENT_CAPABILITY,
  AGENT_SESSION_RENAME_ONLY_CLIENT_CAPABILITY
} from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import {
  AuthorityRuntime,
  B,
  G,
  authorityProfile,
  openAuthorityRuntime
} from './structured-agent-session-tab-authority.test-support'

vi.mock('../../../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

const PHONE = {
  pairedDeviceId: 'phone',
  clientKind: 'mobile' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}
// What the paired CLI sends: launch, rename and close, never structured.v1.
// The local socket declares no client kind; the runtime stamps it as the local CLI.
const LOCAL_CLI = {}
const PAIRED_CLI = {
  pairedDeviceId: 'laptop',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_SESSION_RENAME_ONLY_CLIENT_CAPABILITY,
    AGENT_SESSION_CLOSE_ONLY_CLIENT_CAPABILITY
  ]
}

async function closeRig() {
  const rig = await openAuthorityRuntime(await authorityProfile([], { records: [B], visible: [] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const rpc = new RpcDispatcher({
    runtime: rig.runtime,
    methods: [STRUCTURED_AGENT_SESSION_CLOSE_METHOD, ...STRUCTURED_AGENT_SESSION_REVEAL_METHODS]
  })
  const call = (method: string, sessionId: string, ctx: typeof PHONE | typeof PAIRED_CLI) =>
    rpc.dispatch({ id: method, authToken: 'token', method, params: { sessionId } }, ctx)
  return call
}

it('reports found only when the session id names a chat on this host', async () => {
  const call = await closeRig()

  expect(await call('agentSession.close', G, PHONE)).toMatchObject({
    ok: true,
    result: { ok: true, found: false }
  })
  expect(await call('agentSession.close', B, PHONE)).toMatchObject({
    ok: true,
    result: { ok: true, found: true }
  })
})

it('lets the paired CLI close a chat and nothing else', async () => {
  const call = await closeRig()

  expect(await call('agentSession.reveal', B, PAIRED_CLI)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('structured_agent_session_unsupported') }
  })
  expect(await call('agentSession.close', B, PAIRED_CLI)).toMatchObject({
    ok: true,
    result: { ok: true, found: true }
  })
})

// After a restart a saved chat can be at rest before any window or phone has built the host.
it.each([
  ['the local CLI', LOCAL_CLI],
  ['the paired CLI', PAIRED_CLI]
])('lets %s close a chat at rest before the host is built', async (_caller, cli) => {
  const { profile } = await authorityProfile([B], { records: [B], visible: [B] })
  const rpc = new RpcDispatcher({
    runtime: new AuthorityRuntime(profile),
    methods: [STRUCTURED_AGENT_SESSION_CLOSE_METHOD]
  })
  const close = (ctx: object) =>
    rpc.dispatch(
      { id: 'close', authToken: 'token', method: 'agentSession.close', params: { sessionId: B } },
      ctx
    )

  expect(await close(PHONE)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('structured_agent_session_unsupported') }
  })
  expect(await close(cli)).toMatchObject({ ok: true, result: { ok: true, found: true } })
})
