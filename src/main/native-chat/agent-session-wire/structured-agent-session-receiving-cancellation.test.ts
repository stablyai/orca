import { expect, it, vi } from 'vitest'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { REST_TEST_CALLER } from './structured-agent-session-rest-test-rig'
import { hostTestMessage, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createReceivingCallerFixture,
  HOME_B,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

it('finishes an owned ordinary open but direct cancellation publishes no child', async () => {
  const f = await createReceivingCallerFixture()
  const opened = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await f.found()
    await f.coldNative()
    f.selectB()
    const original = acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))
    const open = AgentSessionJournal.prototype.open
    vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementationOnce(async function (
      this: AgentSessionJournal
    ) {
      opened.resolve()
      await release.promise
      return open.call(this)
    })
    f.rig.adapter.acquire.mockClear()
    const result = f.ensure().then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    await opened.promise
    f.rig.host
      .collaboratorsForTests()
      .runtimeState.acquireAborts.abort(PARENT, 'cancelled while opening')
    release.resolve()
    await result
    expect(f.rig.host.hasSession(PARENT)).toBe(true)
    expect(f.rig.host.childAccountHome(PARENT)).toBeUndefined()
    expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    expect(acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe).toEqual(
      original?.recipe
    )
    expect(f.rig.store.requireWritableRecord(PARENT).lease.claimStatus).toBe('released')
  } finally {
    release.resolve()
    await f.dispose()
  }
})

it('a real Stop remains responsive while a background start awaits the selected resolver', async () => {
  const f = await createReceivingCallerFixture()
  const release = Promise.withResolvers<void>()
  try {
    await f.found()
    await f.rig.host.close(PARENT, 'evict')
    const original = acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))
    const resolution = vi
      .spyOn(f.rig.host.deps, 'launchAccountHome')
      .mockImplementation(async () => {
        await release.promise
        return HOME_B
      })
    f.rig.adapter.acquire.mockClear()
    f.rig.adapter.dispatch.mockClear()
    const id = await f.accept('cancel this background start')
    await vi.waitFor(() => expect(resolution).toHaveBeenCalled())
    const stopped = await f.rig.host.cancel(REST_TEST_CALLER, {
      envelope: {
        sessionId: PARENT,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: PARENT,
          fields: {}
        })
      }
    })
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    release.resolve()
    await vi.waitFor(() =>
      expect(f.rig.host.collaboratorsForTests().runtimeState.startFlights.has(PARENT)).toBe(false)
    )
    expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    expect(f.rig.adapter.dispatch).not.toHaveBeenCalled()
    expect(
      f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal.submission(id)
    ).toMatchObject({ rejection: { kind: 'cancelled' } })
    expect(acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe).toEqual(
      original?.recipe
    )
  } finally {
    release.resolve()
    await f.dispose()
  }
})

it('ensure and ordinary send share the journal refusal; retry retains history without a failed spawn', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    await f.rig.host.close(PARENT, 'evict')
    const before = f.rig.store.requireWritableRecord(PARENT)
    const rows = f.rig.store.listOperationRows()
    const open = vi
      .spyOn(AgentSessionJournal.prototype, 'open')
      .mockRejectedValue(new Error('fixture journal IO unavailable'))
    f.rig.adapter.acquire.mockClear()
    const ensured = await f.ensure()
    expect(ensured).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })
    const body = hostTestMessage('retryable send')
    const sent = await f.rig.host.send(REST_TEST_CALLER, {
      body,
      envelope: {
        sessionId: PARENT,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: before.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: PARENT,
          fields: { body }
        })
      }
    })
    expect(sent).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })
    expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    expect(f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence).toBe(
      before.lease.runtimeFence
    )
    expect(acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe).toEqual(
      acquiredAgentSessionAccount(before)?.recipe
    )
    expect(f.rig.store.listOperationRows()).toEqual(rows)
    open.mockRestore()
    expect(await f.ensure()).toMatchObject({ ok: true })
  } finally {
    await f.dispose()
  }
})
