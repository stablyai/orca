import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
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
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'

let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>

beforeEach(() => {
  ;({ store, host, dispatch, setOption } = hostTestState())
})

function hostJournal(): AgentSessionJournal {
  return (
    host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
  ).sessions.get(SESSION)!.journal
}

/** Wait for final delivery outcome, or handover alone when provider admission remains pending. */
async function delivered(clientMessageId: string, options: { handedOver?: true } = {}) {
  let submission: ReturnType<AgentSessionJournal['submissions']>[number] | undefined
  await vi.waitFor(() => {
    submission = hostJournal()
      .submissions()
      .find((entry) => entry.clientMessageId === clientMessageId)
    expect(submission?.handedOverAt).toBeDefined()
    if (!options.handedOver) {
      expect(submission?.dispatchState).not.toBe('pending')
    }
  })
  return submission!
}

describe('send', () => {
  it('passes each accepted message choice to its provider dispatch and keeps replay immutable', async () => {
    await attach()
    const first = hostTestMessage('first')
    const second = hostTestMessage('second')
    const aOptions = { model: 'model-a', effort: 'high' }
    const bOptions = { model: 'model-b', effort: 'low' }
    const a = {
      envelope: envelope('agentSession.send', { body: first, options: aOptions }),
      body: first,
      options: aOptions
    }
    const b = {
      envelope: envelope('agentSession.send', { body: second, options: bOptions }),
      body: second,
      options: bOptions
    }
    await host.send(CALLER, a)
    await delivered(a.envelope.clientOperationId)
    await host.send(CALLER, b)
    await delivered(b.envelope.clientOperationId)

    expect(dispatch.mock.calls.map(([input]) => input.executionOptions)).toEqual([
      aOptions,
      bOptions
    ])
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(
      hostJournal()
        .submissions()
        .map((submission) => submission.options)
    ).toEqual([aOptions, bOptions])
    await expect(host.send(CALLER, a)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(setOption).not.toHaveBeenCalled()
  })

  it('settles a refused message choice without dispatching its prompt', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new AgentSessionOptionRejectedError('model unavailable'))
    const body = hostTestMessage('do not send')
    const options = { model: 'model-unavailable' }
    const params = {
      envelope: envelope('agentSession.send', { body, options }),
      body,
      options
    }
    const result = await host.send(CALLER, params)
    expect(result).toMatchObject({ ok: true })
    await vi.waitFor(() => {
      expect(
        hostJournal()
          .submissions()
          .find((submission) => submission.clientMessageId === params.envelope.clientOperationId)
      ).toMatchObject({ dispatchState: 'rejected' })
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(setOption).not.toHaveBeenCalled()
  })

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
    if (!('submission' in result.value)) {
      throw new Error('expected the submission arm')
    }
    expect(result.value.submission).toMatchObject({
      dispatchState: 'pending',
      handoverRecorded: true
    })
    expect(result.value.submission.handedOverAt).toBeUndefined()
    await expect(delivered(result.value.clientMessageId)).resolves.toMatchObject({
      dispatchState: 'accepted'
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items).toHaveLength(1)
    expect(page.ok && page.page.fence).toBe(1)
    expect(page.page.hostNow).toBe(NOW)
    expect(page.providerSession).toEqual({ key: 'session_id', id: THREAD })
  })

  it('a submission write failure leaves no accepted operation before provider dispatch', async () => {
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
    ).toBeUndefined()
  })

  it('settles a thrown dispatch as unknown, never as a rejection', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const body = hostTestMessage('add a retry')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    await expect(delivered(params.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'unknown'
    })
  })

  it('replays a retried send from the journal without dispatching twice', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    await delivered(params.envelope.clientOperationId)
    const retry = await host.send(CALLER, params)
    expect(retry).toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses to redeliver an explicitly retried unknown from a thrown adapter call', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const body = hostTestMessage('possibly delivered')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    await expect(delivered(params.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'unknown'
    })
    // Adapter throws may be lost replies; same-ID Retry must replay.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const state = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('refuses to redeliver an unknown however strongly its reason reads', async () => {
    await attach()
    // A legacy reason on unknown state proves no non-delivery and cannot authorize resend.
    dispatch
      .mockImplementationOnce(async () => ({
        state: 'unknown' as const,
        reason: 'provider_write_failed: broken pipe'
      }))
      .mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('never written')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    await delivered(params.envelope.clientOperationId)
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: {
        submission: { dispatchState: 'unknown', reason: 'provider_write_failed: broken pipe' }
      }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const state = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('settles a refused write as rejected and delivers a rotated id exactly once', async () => {
    await attach()
    dispatch
      .mockImplementationOnce(async () => ({
        state: 'rejected' as const,
        ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), {
          surface: 'rejection'
        })
      }))
      .mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('never written')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    await expect(delivered(params.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'rejected',
      reason: 'provider_write_failed'
    })
    // Explicit rejection permits a fresh-ID user retry after proven non-delivery.
    const rotated = { envelope: envelope('agentSession.send', { body }), body }
    await expect(host.send(CALLER, rotated)).resolves.toMatchObject({ ok: true, replayed: false })
    await expect(delivered(rotated.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'accepted'
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const state = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(2)
  })

  it('refuses to redeliver a retry for a message the provider may already hold', async () => {
    await attach()
    // Child exit ends the wait but cannot undo bytes already written to stdin.
    dispatch.mockImplementationOnce(async () => ({
      state: 'unknown' as const,
      reason: DISPATCH_DOUBT_PROVIDER_EXITED
    }))
    const body = hostTestMessage('a message the provider may already hold')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await host.send(CALLER, params)
    await expect(delivered(params.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'unknown'
    })
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
    await delivered(params.envelope.clientOperationId)
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 1

    // Neither recovery uncertainty nor direct unknown settlement may undo acceptance.
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

  it('leaves an admitted send pending once handed over', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('queued behind a running turn')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending', reason: null, resolvedAt: null } }
    })
    await delivered(params.envelope.clientOperationId, { handedOver: true })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const journal = hostJournal()
    expect(journal.pendingSubmissions()).toHaveLength(1)
  })

  it('refuses to redeliver an admitted send a host restart left unanswered', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('written, never acknowledged')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    await delivered(params.envelope.clientOperationId, { handedOver: true })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal

    await journal.markPendingSubmissionsUnknown(store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    expect(journal.submissions()).toMatchObject([
      { dispatchState: 'unknown', reason: 'host_restarted_before_acknowledgement' }
    ])

    // Claude resumes the same provider session; exit after stdin write leaves delivery uncertain.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(journal.submissions()).toHaveLength(1)
  })

  it('answers a send whose ledger settlement fails, its row committed with the submission', async () => {
    await attach()
    vi.spyOn(store, 'recordOperationOutcome').mockRejectedValue(
      new Error('operation settlement failed')
    )
    const body = hostTestMessage('accepted while settlement fails')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    const clientMessageId = params.envelope.clientOperationId

    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
    expect(
      store.listOperationRows().find((row) => row.operationId === clientMessageId)
    ).toMatchObject({ outcome: { status: 'succeeded' } })
    await delivered(clientMessageId)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('runs a send that threw before writing for the first time when it is resent, once', async () => {
    await attach()
    const body = hostTestMessage('first delivery after caller recovery')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    const clientMessageId = params.envelope.clientOperationId
    const beforeRun = () => {
      throw new Error('host fault before the write')
    }

    await expect(host.send(CALLER, { ...params, beforeRun })).rejects.toThrow(
      'host fault before the write'
    )
    expect(hostJournal().submissions()).toHaveLength(0)
    expect(
      store.listOperationRows().find((row) => row.operationId === clientMessageId)
    ).toBeUndefined()

    await expect(host.send({ callerKey: 'client-after-recovery' }, params)).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { clientMessageId, dispatchState: 'pending' } }
    })
    await delivered(clientMessageId)
    expect(
      store.listOperationRows().find((row) => row.operationId === clientMessageId)
    ).toMatchObject({ callerKey: 'client-after-recovery', outcome: { status: 'succeeded' } })
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("retains an older build's positive original across an epoch despite unknown bookkeeping, never redelivering", async () => {
    await attach()
    const body = hostTestMessage('delivered before epoch recovery')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    await delivered(params.envelope.clientOperationId)
    const original = hostJournal()
      .submissions()
      .find((row) => row.clientMessageId === params.envelope.clientOperationId)
    const receipt = store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)
    // Model legacy unknown bookkeeping written before execution.
    await store.recordOperationOutcome({
      callerKey: CALLER.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'pending' }
    })
    await store.recordOperationOutcome({
      callerKey: CALLER.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'unknown' }
    })
    const journal = hostJournal()
    await journal.rollEpoch('schema_unreadable', store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    expect(journal.submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'accepted',
        providerItemId: expect.any(String)
      }
    ])

    await expect(
      host.send({ callerKey: 'client-after-recovery' }, { ...params, retryUnknown: true })
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        submission: {
          clientMessageId: params.envelope.clientOperationId,
          dispatchState: 'accepted',
          providerItemId: expect.any(String),
          reason: null
        }
      }
    })
    expect(
      hostJournal()
        .submissions()
        .find((row) => row.clientMessageId === params.envelope.clientOperationId)
    ).toEqual(original)
    expect(hostJournal().submissionBody(params.envelope.clientOperationId)).toEqual(body)
    expect(store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)).toEqual(
      receipt
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(journal.submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'accepted',
        providerItemId: expect.any(String)
      }
    ])
  })

  it('answers a retained accepted original after a new epoch, never by running it again', async () => {
    await attach()
    const body = hostTestMessage('accepted, then the epoch was replaced')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    await delivered(params.envelope.clientOperationId)
    const original = hostJournal()
      .submissions()
      .find((row) => row.clientMessageId === params.envelope.clientOperationId)
    const receipt = store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)
    await hostJournal().rollEpoch(
      'schema_unreadable',
      store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    )

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: {
        submission: {
          clientMessageId: params.envelope.clientOperationId,
          dispatchState: 'accepted',
          providerItemId: expect.any(String),
          reason: null
        }
      }
    })
    expect(
      hostJournal()
        .submissions()
        .find((row) => row.clientMessageId === params.envelope.clientOperationId)
    ).toEqual(original)
    expect(hostJournal().submissionBody(params.envelope.clientOperationId)).toEqual(body)
    expect(store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)).toEqual(
      receipt
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses to redeliver an admitted send whose child exited first', async () => {
    await attach()
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    const body = hostTestMessage('written, then the child died')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    await delivered(params.envelope.clientOperationId, { handedOver: true })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
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
    const journal = hostJournal()
    const resolve = journal.resolveDispatch.bind(journal)
    // Persist handover but fail provider settlement after the adapter takes the message.
    vi.spyOn(journal, 'resolveDispatch')
      .mockImplementationOnce(resolve)
      .mockRejectedValueOnce(new Error('journal resolve failed'))
    const body = hostTestMessage('possibly delivered before persistence failed')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true })
    await expect(delivered(params.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'unknown'
    })
    // Ledger records host acceptance; journal records provider delivery.
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
        ?.outcome
    ).toMatchObject({ status: 'succeeded' })
    expect(dispatch).toHaveBeenCalledTimes(1)

    await journal.markPendingSubmissionsUnknown(store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Failed persistence after provider write cannot authorize duplicate dispatch.
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(journal.submissions()).toHaveLength(1)
  })

  it('admits a send fenced to another generation, delivers it once, and replays it by id', async () => {
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
    expect(await host.send(CALLER, params)).toMatchObject({ ok: true, replayed: false })
    await expect(delivered(params.envelope.clientOperationId)).resolves.toMatchObject({
      dispatchState: 'accepted'
    })
    const retry = {
      ...params,
      envelope: { ...params.envelope, expectedRuntimeFence: record?.lease.runtimeFence ?? 1 }
    }
    expect(await host.send(CALLER, retry)).toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses any mutation against a session this host has not attached', async () => {
    const body = hostTestMessage('add a retry')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_ownership_unknown' } })
  })
})
