import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

it.each(['approval', 'question'] as const)(
  'probes %s receipts without executing missing answers and replays after restart without opening',
  async (kind) => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const prompt = await journal.appendItem(
      { provider: 'orca', clientMessageId: 'prompt' },
      {
        ...(kind === 'approval'
          ? { kind, title: 'Approve?', detail: null }
          : { kind, question: 'Choose?' }),
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'yes' }
    const params = {
      ...fields,
      kind,
      envelope: rig.envelope(fields, `agentSession.respondTo:${kind}`, hostTestOperationId())
    }
    const answer = vi.spyOn(rig.host.collaboratorsForTests().deps.adapter, 'answerPrompt')
    const before = await journal.reads.cursor()
    expect(await rig.host.respondToPrompt(CALLER, { ...params, replayOnly: true })).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'receiptMissing' } }
    })
    expect(await journal.reads.cursor()).toEqual(before)
    expect(
      await rig.store.readCommandReceipt(
        { kind: 'caller', callerKey: CALLER.callerKey },
        params.envelope.clientOperationId
      )
    ).toEqual({ verdict: 'absent' })
    expect(answer).not.toHaveBeenCalled()

    const accepted = await rig.host.respondToPrompt(CALLER, params)
    expect(accepted).toMatchObject({ ok: true, replayed: false })
    expect(answer).toHaveBeenCalledTimes(1)
    if (!accepted.ok) {
      throw new Error('answer was refused')
    }
    const acceptedValue = accepted.value
    rig.crashRestartHostProcess()
    expect(rig.host.collaboratorsForTests().sessions.size).toBe(0)
    const starts = rig.starts.mock.calls.length
    expect(await rig.host.respondToPrompt(CALLER, { ...params, replayOnly: true })).toMatchObject({
      ok: true,
      replayed: true,
      value: acceptedValue
    })
    expect(rig.host.collaboratorsForTests().sessions.size).toBe(0)
    expect(rig.starts).toHaveBeenCalledTimes(starts)
    expect(answer).toHaveBeenCalledTimes(1)
    expect(await journal.reads.cursor()).toEqual(accepted.cursor)
    expect(
      await rig.host.respondToPrompt({ callerKey: 'other' }, { ...params, replayOnly: true })
    ).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'receiptMissing' } }
    })
    const changed = { ...fields, optionId: 'no' }
    expect(
      await rig.host.respondToPrompt(CALLER, {
        ...params,
        ...changed,
        replayOnly: true,
        envelope: rig.envelope(
          changed,
          `agentSession.respondTo:${kind}`,
          params.envelope.clientOperationId
        )
      })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_conflict' } })
    const pointReader = vi.spyOn(
      rig.host.collaboratorsForTests().deps.journalDatabase.readers,
      'point'
    )
    pointReader.mockRejectedValue(new Error('reader closed'))
    try {
      expect(await rig.host.respondToPrompt(CALLER, { ...params, replayOnly: true })).toMatchObject(
        {
          ok: false,
          refusal: { code: 'agent_session_operation_unknown' }
        }
      )
    } finally {
      pointReader.mockRestore()
    }
    vi.spyOn(rig.store, 'readCommandReceipt').mockRejectedValueOnce(new Error('reader closed'))
    expect(await rig.host.respondToPrompt(CALLER, { ...params, replayOnly: true })).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(rig.host.collaboratorsForTests().sessions.size).toBe(0)
    expect(answer).toHaveBeenCalledTimes(1)
    expect(await rig.host.respondToPrompt(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: acceptedValue
    })
    expect(answer).toHaveBeenCalledTimes(1)
  }
)
