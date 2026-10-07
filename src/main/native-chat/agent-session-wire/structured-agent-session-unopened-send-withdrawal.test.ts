// Which sends a Stop takes back, at its child's end or once Codex takes it: the same rule decides the withdrawal and whether the
// Stop writes a row, so a send it must leave alone is left alone by both.

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

/** A send that started its own turn before a person's Stop at sequence 10, no turn having opened. */
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

/** A turn that ended at sequence 4, before a handover at 5. */
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

  // An earlier process's send: its child may have started it before the crash.
  it('is never one an earlier process left in doubt', () => {
    expect(sendStopCanTakeBack(sendBeforeStop({ dispatchState: 'unknown', recovered: true }))).toBe(
      false
    )
  })

  // The card holds its text and returns paused; nothing was handed to the agent.
  it("is never a queued card's send that was not handed over", () => {
    expect(sendStopCanTakeBack(sendBeforeStop({ handedOverAt: undefined }))).toBe(false)
  })
})

describe("a Codex child's end, or a Stop Codex took, under a person's Stop", () => {
  it('withdraws a send whose answer this process lost', async () => {
    const { journal, resolveDispatch } = journalWith(sendBeforeStop({ dispatchState: 'unknown' }))

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'send-1', state: 'rejected' })
    )
  })

  it('leaves a send an earlier process left in doubt as it is', async () => {
    const { journal, resolveDispatch } = journalWith(
      sendBeforeStop({ dispatchState: 'unknown', recovered: true })
    )

    await withdrawCodexSendsNoTurnOpenedFor(journal, 1)

    expect(resolveDispatch).not.toHaveBeenCalled()
  })

  // The send could start a turn only once handed over, so a turn that ended before then is not one.
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

  // A send that joined a running turn may be in it.
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
