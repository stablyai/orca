// What one `agentSession.send` writes, and when a user's Retry is allowed to
// put the same message on the wire a second time.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  accepted,
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

beforeEach(() => {
  ;({ store, host, dispatch } = hostTestState())
})

describe('send', () => {
  it('writes the submission before dispatching and resolves it accepted', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    if (!result.ok) {
      throw new Error(`expected a send, got ${result.refusal.code}`)
    }
    expect(result.value.submission.dispatchState).toBe('accepted')
    expect(dispatch).toHaveBeenCalledTimes(1)
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items).toHaveLength(1)
    expect(page.ok && page.page.fence).toBe(1)
    expect(page.providerSession).toEqual({ key: 'session_id', id: THREAD })
  })

  it('settles a thrown dispatch as unknown, never as a rejection', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const body = hostTestMessage('add a retry')
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    expect(result).toMatchObject({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  })

  it('replays a retried send from the journal without dispatching twice', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    const retry = await host.send(CALLER, params)
    expect(retry).toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses to redeliver an explicitly retried unknown from a thrown adapter call', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const body = hostTestMessage('possibly delivered')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    const first = await host.send(CALLER, params)
    expect(first).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    // A thrown adapter call is indistinguishable from a lost reply, so it is not
    // on the allowlist: Retry replays the recorded outcome.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const state = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('redispatches an explicitly retried unknown the write itself refused', async () => {
    await attach()
    dispatch
      .mockImplementationOnce(async () => ({
        state: 'unknown' as const,
        reason: 'provider_write_failed: broken pipe'
      }))
      .mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('never written')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    // The only doubt on the allowlist: the transport refused the frame, so this
    // is a first delivery and not a second.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const state = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('returns an admitted retry to pending until the provider echo accepts it', async () => {
    await attach()
    dispatch
      .mockImplementationOnce(async () => ({
        state: 'unknown' as const,
        reason: 'provider_write_failed: connection closed before enqueue'
      }))
      .mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('admitted on retry')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: {
        submission: { dispatchState: 'pending', reason: null, resolvedAt: null }
      }
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('refuses to redeliver a retry for a turn the provider already owns', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({
      state: 'unknown' as const,
      reason: 'codex app-server started a turn it did not name in time'
    }))
    const body = hostTestMessage('a turn codex owns but did not name')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    const first = await host.send(CALLER, params)
    expect(first).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    // The turn is running; a second delivery would be a duplicate, so Retry
    // replays the recorded outcome instead of re-sending.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('never reopens a submission the provider already proved delivered', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('settled for good')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 1

    // Every later signal that could assert doubt: the attach sweep, and a
    // direct unknown resolution. Neither may unsettle an accepted answer.
    await journal.markPendingSubmissionsUnknown(fence)
    await journal.resolveDispatch({
      clientMessageId: params.envelope.clientOperationId,
      state: 'unknown',
      reason: 'provider_write_failed: late transport error',
      fence,
      recovered: true
    })

    expect(journal.submissions()).toMatchObject([{ dispatchState: 'accepted', reason: null }])
    expect(journal.receiptFor(params.envelope.clientOperationId)).not.toBeNull()
  })

  it('leaves an admitted send pending and writes no dispatch row', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('queued behind a running turn')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending', reason: null, resolvedAt: null } }
    })
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    expect(journal.pendingSubmissions()).toHaveLength(1)
  })

  it('refuses to redeliver an admitted send a host restart left unanswered', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('written, never acknowledged')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal

    await journal.markPendingSubmissionsUnknown(store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    expect(journal.submissions()).toMatchObject([
      { dispatchState: 'unknown', reason: 'host_restarted_before_acknowledgement' }
    ])

    // The frame was already written to the dead child's stdin, and Claude resumes
    // the same provider session by id, so the restart ends the wait without
    // proving non-delivery. Re-typing costs a message; redelivering costs a
    // duplicate in the model's conversation.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(journal.submissions()).toHaveLength(1)
  })

  it('refuses to redeliver an admitted send whose child exited first', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('written, then the child died')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal

    await journal.markPendingSubmissionsUnknown(
      store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      'provider_exited_before_acknowledgement'
    )

    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('advances an explicit retry after a ledger-unknown send is reconciled in the journal', async () => {
    await attach()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    vi.spyOn(journal, 'resolveDispatch').mockRejectedValueOnce(new Error('journal resolve failed'))
    const body = hostTestMessage('possibly delivered before persistence failed')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).rejects.toThrow('journal resolve failed')
    expect(journal.submissions()).toMatchObject([
      { clientMessageId: params.envelope.clientOperationId, dispatchState: 'unknown' }
    ])
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
        ?.outcome
    ).toEqual({ status: 'unknown' })
    expect(dispatch).toHaveBeenCalledTimes(1)

    await journal.markPendingSubmissionsUnknown(store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)

    // The adapter took the message before the journal write failed, so the
    // provider may already have it: an explicit retry replays, never redelivers.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(journal.submissions()).toHaveLength(1)
  })

  it('refuses a stale fence and hands back the current one', async () => {
    const record = await attach()
    const body = hostTestMessage('add a retry')
    const result = await host.send(CALLER, {
      envelope: envelope(
        'agentSession.send',
        { body },
        { expectedRuntimeFence: (record?.lease.runtimeFence ?? 1) + 5 }
      ),
      body
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', currentFence: record?.lease.runtimeFence }
    })
  })

  it('does not let a refused call leave a ledger row that replays past the fence', async () => {
    const record = await attach()
    const body = hostTestMessage('add a retry')
    const params = {
      envelope: envelope(
        'agentSession.send',
        { body },
        { expectedRuntimeFence: (record?.lease.runtimeFence ?? 1) + 5 }
      ),
      body
    }
    await host.send(CALLER, params)
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses any mutation against a session this host has not attached', async () => {
    const body = hostTestMessage('add a retry')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_ownership_unknown' } })
  })
})
