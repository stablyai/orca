import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import {
  adapter,
  attachParams,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { DISPATCH_REJECTED_PROVIDER_NOT_OWNED } from '../../../shared/structured-agent-session-dispatch-rejection'

it('settles a missing provider owner as not sent and retries after ownership repair', async () => {
  const state = hostTestState()
  await state.host.flushAllStreamedEvents()
  const provider = {
    ...adapter(),
    supportsLocation: () => true,
    readOptions: async () => ({ models: [], current: { model: 'test-model' } }),
    closeSession: vi.fn(async () => true)
  }
  const router = new StructuredAgentSessionAdapterRouter(
    { codex: provider, claude: provider },
    async () => {}
  )
  const host = new StructuredAgentSessionHost({
    store: state.store,
    adapter: router,
    journalRoot: state.root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  replaceHostTestState({ store: state.store, host })
  const attached = await host.attach(CALLER, attachParams())
  expect(attached).toMatchObject({ ok: true })

  // The host still has the durable journal, but the router has a stopped route. This is the
  // effect boundary the old generic throw erased.
  await expect(router.closeSession(SESSION)).resolves.toBe(true)
  const body = hostTestMessage('diagnostic after close')
  const request = { envelope: envelope('agentSession.send', { body }), body }
  const first = await host.send(CALLER, request)
  expect(first).toMatchObject({
    ok: true,
    value: {
      submission: {
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_PROVIDER_NOT_OWNED
      }
    }
  })
  expect(state.dispatch).not.toHaveBeenCalled()

  // Replaying the same id is still a journal replay, never a second provider attempt.
  await expect(host.send(CALLER, { ...request, retryUnknown: true })).resolves.toMatchObject({
    ok: true,
    replayed: true,
    value: { submission: { dispatchState: 'rejected' } }
  })
  expect(state.dispatch).not.toHaveBeenCalled()

  // Once ownership is repaired, the outbox's existing rejection path uses a fresh id. It can
  // deliver the same user intent without reopening the rejected row or creating a resend loop.
  await router.acquire({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    fence: state.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    spawnToken: 'spawn-a'
  })
  const repairedBody = hostTestMessage('diagnostic after close')
  const repaired = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body: repairedBody }),
    body: repairedBody
  })
  expect(repaired).toMatchObject({
    ok: true,
    replayed: false,
    value: { submission: { dispatchState: 'accepted' } }
  })
  expect(state.dispatch).toHaveBeenCalledTimes(1)
})
