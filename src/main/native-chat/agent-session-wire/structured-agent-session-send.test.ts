// What one `agentSession.send` writes, and when a user's Retry is allowed to
// put the same message on the wire a second time.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  accepted,
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
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
    expect(page.page.hostNow).toBe(NOW)
    expect(page.providerSession).toEqual({ key: 'session_id', id: THREAD })
  })

  it('settles a submission write failure as rejected before provider dispatch', async () => {
    await attach()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    vi.spyOn(journal, 'appendSubmission').mockRejectedValueOnce(new Error('disk full'))
    const body = hostTestMessage('not durably recorded')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
    ).toMatchObject({ outcome: { status: 'failed' } })
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
    // A thrown adapter call is indistinguishable from a lost reply, so Retry
    // replays the recorded outcome.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const state = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('refuses to redeliver an unknown however strongly its reason reads', async () => {
    await attach()
    // The reason that used to be the sole entry on the redelivery allowlist. It
    // is now a rejection when it is real, so an `unknown` still carrying it is
    // only a claim -- and no claim unlocks a second delivery under one id.
    dispatch
      .mockImplementationOnce(async () => ({
        state: 'unknown' as const,
        reason: 'provider_write_failed: broken pipe'
      }))
      .mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('never written')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: {
        submission: { dispatchState: 'unknown', reason: 'provider_write_failed: broken pipe' }
      }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const state = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('settles a refused write as rejected and delivers a rotated id exactly once', async () => {
    await attach()
    dispatch
      .mockImplementationOnce(async () => ({
        state: 'rejected' as const,
        reason: 'provider_write_failed: broken pipe'
      }))
      .mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('never written')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      value: {
        submission: { dispatchState: 'rejected', reason: 'provider_write_failed: broken pipe' }
      }
    })
    // What the user's Retry does with a rejection: a fresh client message id,
    // which is a first delivery by construction and cannot duplicate the frame
    // that never left the process.
    await expect(
      host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const state = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(2)
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

  it('reconstructs an accepted send after the ledger settlement is lost', async () => {
    await attach()
    const persist = store.recordOperationOutcome.bind(store)
    let failSettlement = true
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (failSettlement && input.outcome.status === 'succeeded') {
        failSettlement = false
        throw new Error('operation settlement failed')
      }
      return persist(input)
    })
    const body = hostTestMessage('accepted before settlement failed')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).rejects.toThrow('operation settlement failed')
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('never reruns an admission-only send after the caller changes', async () => {
    await attach()
    const settlement = vi
      .spyOn(store, 'recordOperationOutcome')
      .mockRejectedValue(new Error('operation settlement failed'))
    const body = hostTestMessage('first delivery after caller recovery')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).rejects.toThrow('operation settlement failed')
    expect(dispatch).not.toHaveBeenCalled()
    settlement.mockRestore()

    await expect(host.send({ callerKey: 'client-after-recovery' }, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        submission: {
          dispatchState: 'unknown',
          reason: DISPATCH_DOUBT_SUBMISSION_MISSING
        }
      }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
    ).toMatchObject({ callerKey: CALLER.callerKey, outcome: { status: 'pending' } })
  })

  it('never redelivers after admission survives without its journal submission', async () => {
    await attach()
    const persist = store.recordOperationOutcome.bind(store)
    const settlement = vi
      .spyOn(store, 'recordOperationOutcome')
      .mockImplementation(async (input) => {
        if (input.outcome.status === 'succeeded') {
          throw new Error('operation settlement failed')
        }
        return persist(input)
      })
    const body = hostTestMessage('delivered before epoch recovery')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).rejects.toThrow('operation settlement failed')
    settlement.mockRestore()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    await journal.rollEpoch('schema_unreadable', store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    expect(journal.submissions()).toHaveLength(0)

    await expect(
      host.send({ callerKey: 'client-after-recovery' }, { ...params, retryUnknown: true })
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        submission: {
          dispatchState: 'unknown',
          reason: DISPATCH_DOUBT_SUBMISSION_MISSING,
          recovered: true
        }
      }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(journal.submissions()).toHaveLength(0)
  })

  it('fails closed when a legacy pending row survives without its submission', async () => {
    await attach()
    const body = hostTestMessage('legacy pending send after caller recovery')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    expect(dispatch).toHaveBeenCalledTimes(1)
    await store.recordOperationOutcome({
      callerKey: CALLER.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'pending' }
    })

    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    await journal.rollEpoch('schema_unreadable', store.getRecord(SESSION)?.lease.runtimeFence ?? 1)

    await expect(host.send({ callerKey: 'client-after-recovery' }, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        submission: {
          dispatchState: 'unknown',
          reason: DISPATCH_DOUBT_SUBMISSION_MISSING
        }
      }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
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
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'unknown' } }
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

  it('settles a refused send so its admission row cannot replay past the fence', async () => {
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
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
    ).toMatchObject({ outcome: { status: 'failed', code: 'agent_session_checkpoint_stale' } })
  })

  it('refuses any mutation against a session this host has not attached', async () => {
    const body = hostTestMessage('add a retry')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_ownership_unknown' } })
  })
})
