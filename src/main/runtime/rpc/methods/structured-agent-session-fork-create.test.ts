import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  call,
  clearStructuredHostStub,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

it('forwards a fork under the fingerprint its client declared, and refuses one that does not match', async () => {
  const forkFrom = { sessionId: 'codex_parent_chat', itemId: 'codex:thread:turn-1:1' }
  // Built the way every client builds it, so both sides digest the same fields.
  const params = structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    forkFrom,
    randomUuid: () => '00000000-0000-4000-8000-000000000001'
  })

  expect(await call('agentSession.create', params, STRUCTURED_CLIENT)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledWith(
    expect.objectContaining({ forkFrom })
  )

  // The same envelope naming another turn is a different create, not a replay of this one.
  const other = { ...params, forkFrom: { ...forkFrom, itemId: 'codex:thread:turn-2:1' } }
  expect(await call('agentSession.create', other, STRUCTURED_CLIENT)).toMatchObject({
    ok: true,
    result: { ok: false }
  })
})

it('installs the host before resolving a fork, which is read from the chat that host holds', async () => {
  setStructuredAgentSessionHost(null)
  const ensureHost = vi.fn(async () => {
    installStructuredHostStub()
  })
  const params = structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    forkFrom: { sessionId: 'codex_parent_chat', itemId: 'codex:thread:turn-1:1' },
    randomUuid: () => '00000000-0000-4000-8000-000000000002'
  })

  await call('agentSession.create', params, STRUCTURED_CLIENT, {
    ensureStructuredAgentSessionHost: ensureHost
  })

  expect(ensureHost.mock.invocationCallOrder[0]).toBeLessThan(
    runtimeCalls.resolveStructuredAgentSessionCreateIntent.mock.invocationCallOrder[0]
  )
})
