import { beforeEach, expect, it, vi } from 'vitest'
import { call } from './structured-agent-session-rpc.test-fixture'

const shortcut = vi.hoisted(() => ({ empty: vi.fn(async () => true) }))
vi.mock('./structured-agent-session-restart-offer-read', () => ({
  restartOffersProvablyEmpty: shortcut.empty
}))

const ensureHost = vi.fn(async () => undefined)
const HOST_BUILDER = { ensureStructuredAgentSessionHost: ensureHost }

// A paired desktop is a remote client; in-process callers carry no client kind at all.
function listRestartOffers(clientCapabilities?: string[]) {
  return call(
    'agentSession.restartResumable',
    {},
    clientCapabilities ? { clientKind: 'runtime', clientCapabilities } : undefined,
    HOST_BUILDER
  )
}

beforeEach(() => {
  ensureHost.mockClear()
  shortcut.empty.mockClear()
  shortcut.empty.mockResolvedValue(true)
})

it('answers an empty capsule without building the chat host', async () => {
  await expect(listRestartOffers()).resolves.toMatchObject({
    ok: true,
    result: { sessions: [], failed: [] }
  })
  expect(ensureHost).not.toHaveBeenCalled()
})

it('still refuses a client that cannot read structured sessions, before looking at the file', async () => {
  await expect(listRestartOffers(['terminal.v1'])).resolves.toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('structured_agent_session_unsupported') }
  })
  expect(shortcut.empty).not.toHaveBeenCalled()
  expect(ensureHost).not.toHaveBeenCalled()
})

it('builds the host when the capsule may hold an offer', async () => {
  shortcut.empty.mockResolvedValue(false)
  // No host comes up in this test, so the build is followed by the usual refusal.
  await expect(listRestartOffers()).resolves.toMatchObject({ ok: false })
  expect(ensureHost).toHaveBeenCalledTimes(1)
})
