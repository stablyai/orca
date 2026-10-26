import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  sendStopCanTakeBack,
  withdrawCodexSendsNoTurnOpenedFor,
  type UnopenedSendJournal
} from './structured-agent-session-unopened-send-withdrawal'

type Send = Pick<
  AgentJournalSubmission,
  | 'clientMessageId'
  | 'dispatchState'
  | 'recovered'
  | 'handoverRecorded'
  | 'handedOverAt'
  | 'acceptedSequence'
>

function sendBeforeStop(overrides: Partial<Send> = {}): Send {
  return {
    clientMessageId: 'send-1',
    dispatchState: 'pending',
    handoverRecorded: true,
    handedOverAt: 5,
    acceptedSequence: 4,
    ...overrides
  }
}

const turnEndedBeforeHandover = {
  itemId: 'turn-0',
  revision: 1,
  sequence: 4,
  observedAt: 4,
  body: { kind: 'turn' as const, turnId: 'turn-0', state: 'completed' as const }
}

function journalWith(
  send: Send,
  turnScope: AgentJournalTurnScope = { kind: 'thread' },
  earlier: (typeof turnEndedBeforeHandover)[] = []
) {
  const resolveDispatch = vi.fn(async () => ({ epoch: 'epoch-1', sequence: 11 }))
  const journal: UnopenedSendJournal = {
    agent: 'codex',
    queuedMessages: {
      userStopInForce: () => ({ sequence: 10, event: { reason: 'user-stop', at: 1 } })
    },
    snapshot: () => ({
      items: [
        ...earlier,
        {
          itemId: agentJournalSubmissionKey(send.clientMessageId),
          revision: 0,
          sequence: 5,
          observedAt: 5,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look around' }] },
          turnScope
        }
      ]
    }),
    submissions: () => [send],
    resolveDispatch
  }
  return { journal, resolveDispatch }
}

describe('a send a Stop can take back', () => {
  it('is one still being handed over, or one this process lost the answer to', () => {
    expect(sendStopCanTakeBack(sendBeforeStop())).toBe(true)
    expect(sendStopCanTakeBack(sendBeforeStop({ dispatchState: 'unknown' }))).toBe(true)
  })

  it('is never one an earlier process left in doubt', () => {
    expect(sendStopCanTakeBack(sendBeforeStop({ dispatchState: 'unknown', recovered: true }))).toBe(
      false
    )
  })

  it("is never a queued card's send that was not handed over", () => {
    expect(sendStopCanTakeBack(sendBeforeStop({ handedOverAt: undefined }))).toBe(false)
  })
})

describe("a Codex child's end, or a Stop Codex took, under a person's Stop", () => {
  it('withdraws a send whose answer this process lost', async () => {
    const { journal, resolveDispatch } = journalWith(sendBeforeStop({ dispatchState: 'unknown' }))

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).toHaveBeenCalledWith(
      // A recorded setup is not proof Codex never received the send.
      expect.objectContaining({
        clientMessageId: 'send-1',
        state: 'rejected',
        rejection: { kind: 'cancelled' }
      })
    )
  })

  it('leaves a send an earlier process left in doubt as it is', async () => {
    const { journal, resolveDispatch } = journalWith(
      sendBeforeStop({ dispatchState: 'unknown', recovered: true })
    )

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).not.toHaveBeenCalled()
  })

  // A turn predating handover cannot belong to that send.
  it('withdraws a send when a turn record was written between its acceptance and its handover', async () => {
    const { journal, resolveDispatch } = journalWith(
      sendBeforeStop({ acceptedSequence: 3 }),
      { kind: 'thread' },
      [turnEndedBeforeHandover]
    )

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'send-1', state: 'rejected' })
    )
  })

  it('leaves a send steered into a running turn as it is', async () => {
    const { journal, resolveDispatch } = journalWith(sendBeforeStop(), {
      kind: 'turn',
      turnItemId: 'turn-item-1'
    })

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).not.toHaveBeenCalled()
  })

  it("leaves a queued card's send as it is", async () => {
    const { journal, resolveDispatch } = journalWith(sendBeforeStop({ handedOverAt: undefined }))

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).not.toHaveBeenCalled()
  })
})
