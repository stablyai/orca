import { afterEach, expect, it, vi } from 'vitest'
import { JournalRetirement } from '../agent-session-journal/journal-retirement'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  attach,
  CALLER,
  ensureParams,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

it('admits and dispatches new work while old history repair fails', async () => {
  const { host, store, acquire, dispatch } = hostTestState()
  const previous = await attach()
  if (!previous) {
    throw new Error('missing record')
  }
  acquire.mock.calls[0]?.[0].events?.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'old', ordinal: 1 },
    { kind: 'turn', turnId: 'old', state: 'running' }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  const released = await store.evictProvenDeadOwner({
    sessionId: HOST_TEST_SESSION,
    expectedFence: previous.lease.runtimeFence,
    probe: { outcome: 'pid-absent' },
    now: HOST_TEST_NOW
  })
  vi.spyOn(JournalRetirement.prototype, 'repairItem').mockRejectedValue(
    new Error('old repair unavailable')
  )
  expect(await host.attach(CALLER, ensureParams(released.lease.runtimeFence))).toMatchObject({
    ok: true
  })
  expect(store.getRecord(HOST_TEST_SESSION)?.retirements?.receipts).toHaveLength(1)
  const body = hostTestMessage('new work')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  expect(dispatch).toHaveBeenCalledOnce()
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValue(
    new Error('new durable write failed')
  )
  const failedBody = hostTestMessage('must never dispatch')
  const attempt = host.send(CALLER, {
    envelope: envelope('agentSession.send', { body: failedBody }),
    body: failedBody
  })
  await expect(attempt).resolves.toMatchObject({ ok: false })
  expect(dispatch).toHaveBeenCalledOnce()
})
