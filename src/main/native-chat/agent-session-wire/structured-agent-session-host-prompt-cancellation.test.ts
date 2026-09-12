import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_SESSION_PROMPT_CANCEL_MAX_PROMPTS } from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let promptCancellation: Mock<NonNullable<StructuredAgentSessionAdapter['promptCancellation']>>

beforeEach(() => {
  ;({ store, host, acquire, promptCancellation, cancelTurn } = hostTestState())
})

describe('prompt cancellation recovery', () => {
  it('retains prompt cancellation recovery when the provider reply is ambiguous', async () => {
    await attach()
    const prompt = await seedApproval()
    cancelTurn.mockRejectedValueOnce(new Error('interrupt reply lost'))
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('interrupt reply lost')
    expect(store.listOperationRows().at(-1)?.outcome).toMatchObject({
      status: 'unknown',
      promptCancelSettlement: { phase: 'prepared', target: fields.prompt }
    })

    await expect(host.cancel(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(2)
  })

  it('retries only durable prompt settlement after a confirmed interruption', async () => {
    await attach()
    const prompt = await seedApproval()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const cancelPrompts = vi
      .spyOn(journal, 'cancelPromptsAtRevisions')
      .mockRejectedValueOnce(new Error('prompt settlement failed'))
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('prompt settlement failed')
    expect(store.listOperationRows().at(-1)?.outcome).toMatchObject({
      status: 'unknown',
      promptCancelSettlement: {
        sessionId: SESSION,
        turnId: 'turn-1',
        prompts: [{ itemId: prompt.itemId, expectedRevision: prompt.revision }]
      }
    })
    expect(journal.snapshot().items.find((item) => item.itemId === prompt.itemId)).toMatchObject({
      revision: prompt.revision,
      body: { resolution: { state: 'pending' } }
    })

    await expect(host.cancel(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { turnId: 'turn-1', cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
    expect(cancelPrompts).toHaveBeenCalledTimes(2)
    expect(journal.snapshot().items.find((item) => item.itemId === prompt.itemId)).toMatchObject({
      revision: prompt.revision + 1,
      body: { resolution: { state: 'cancelled' } }
    })
  })

  it('finishes provider-confirmed journal recovery under the current host fence', async () => {
    await attach()
    const prompt = await seedApproval()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    vi.spyOn(journal, 'cancelPromptsAtRevisions').mockRejectedValueOnce(
      new Error('prompt settlement failed')
    )
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('prompt settlement failed')
    expect(store.listOperationRows().at(-1)?.outcome).toMatchObject({
      status: 'unknown',
      promptCancelSettlement: { phase: 'provider-confirmed' }
    })
    const replacement = await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
    }))
    await expect(
      host.cancel(CALLER, {
        ...params,
        envelope: {
          ...params.envelope,
          expectedRuntimeFence: replacement.lease.runtimeFence
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('retries the same operation after the prepared intent fails before interruption', async () => {
    await attach()
    const prompt = await seedApproval()
    const preparedFailure = vi
      .spyOn(store, 'recordOperationOutcomeIfCurrent')
      .mockRejectedValueOnce(new Error('prepared intent failed'))
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('prepared intent failed')
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(store.listOperationRows().at(-1)?.outcome).toEqual({ status: 'pending' })
    preparedFailure.mockRestore()

    await expect(host.cancel(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('refuses a stale fence before resuming a prepared prompt cancellation', async () => {
    await attach()
    const prompt = await seedApproval()
    cancelTurn.mockRejectedValueOnce(new Error('completion pending'))
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('completion pending')
    await expect(
      host.cancel(CALLER, {
        ...params,
        envelope: {
          ...params.envelope,
          expectedRuntimeFence: params.envelope.expectedRuntimeFence! + 1
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('does not resume a prepared prompt cancellation under a replacement owner', async () => {
    await attach()
    const prompt = await seedApproval()
    cancelTurn.mockRejectedValueOnce(new Error('completion pending'))
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('completion pending')
    const replacement = await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
    }))
    await expect(
      host.cancel(CALLER, {
        ...params,
        envelope: {
          ...params.envelope,
          expectedRuntimeFence: replacement.lease.runtimeFence
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('recovers from confirmation-receipt failure without interrupting the provider twice', async () => {
    await attach()
    const prompt = await seedApproval()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const displayed = await journal.readItem(prompt.itemId)
    const identity = parseAgentJournalItemKey(prompt.itemId)
    const events = acquire.mock.calls[0]?.[0].events
    if (!displayed || !identity || displayed.body.kind !== 'approval') {
      throw new Error('test prompt was not journaled')
    }
    const approvalBody = displayed.body
    cancelTurn.mockImplementationOnce(async (input) => {
      events?.appendLifecycleBatch?.(
        input.promptCancellationId!,
        [
          {
            kind: 'item',
            identity,
            body: {
              ...approvalBody,
              resolution: {
                state: 'cancelled',
                selectedOptionId: null,
                resolvedBy: null,
                resolvedAt: null,
                settlementId: input.promptCancellationId
              }
            }
          }
        ],
        { lifecycle: true }
      )
      return { cancelled: true }
    })
    const originalRecord = store.recordOperationOutcomeIfCurrent.bind(store)
    const receiptFailure = vi
      .spyOn(store, 'recordOperationOutcomeIfCurrent')
      .mockImplementation((input) =>
        input.outcome.status === 'unknown' &&
        input.outcome.promptCancelSettlement?.phase === 'provider-confirmed'
          ? Promise.reject(new Error('confirmation receipt failed'))
          : originalRecord(input)
      )
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('confirmation receipt failed')
    expect(store.listOperationRows().at(-1)?.outcome).toMatchObject({
      status: 'unknown',
      promptCancelSettlement: { phase: 'prepared', target: fields.prompt }
    })
    ;(
      journal as unknown as { state: { appliedSettlementIds: Set<string> } }
    ).state.appliedSettlementIds.clear()
    receiptFailure.mockRestore()

    const replacement = await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
    }))

    await expect(
      host.cancel(CALLER, {
        ...params,
        envelope: { ...params.envelope, expectedRuntimeFence: replacement.lease.runtimeFence }
      })
    ).resolves.toMatchObject({ ok: true, replayed: true, value: { cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('does not attribute a later prompt cancellation to an unknown operation', async () => {
    await attach()
    const prompt = await seedApproval()
    cancelTurn.mockResolvedValueOnce({ cancelled: false })
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const appendItem = journal.appendItem.bind(journal)
    const statusFailure = vi
      .spyOn(journal, 'appendItem')
      .mockImplementation((identity, body, options) =>
        body.kind === 'status'
          ? Promise.reject(new Error('status persistence failed'))
          : appendItem(identity, body, options)
      )
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const params = {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    }

    await expect(host.cancel(CALLER, params)).rejects.toThrow('status persistence failed')
    statusFailure.mockRestore()
    await journal.cancelPromptsAtRevisions({
      prompts: [{ itemId: prompt.itemId, expectedRevision: prompt.revision }],
      settlementId: 'another-operation',
      resolvedBy: 'another-client',
      resolvedAt: NOW + 1,
      fence: 1
    })

    await expect(host.cancel(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('refuses a provider prompt identity that cannot fit the durable receipt', async () => {
    await attach()
    const prompt = await seedApproval()
    promptCancellation.mockReturnValueOnce({
      turnId: 'é'.repeat(257),
      itemIds: [prompt.itemId]
    })
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }

    await expect(
      host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', fields),
        ...fields
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('refuses a prompt group that cannot fit the durable receipt', async () => {
    await attach()
    const prompt = await seedApproval()
    promptCancellation.mockReturnValueOnce({
      turnId: 'turn-1',
      itemIds: [
        prompt.itemId,
        ...Array.from(
          { length: AGENT_SESSION_PROMPT_CANCEL_MAX_PROMPTS },
          (_, index) => `orca:prompt-${index}`
        )
      ]
    })
    const fields = {
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }

    await expect(
      host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', fields),
        ...fields
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })
})
