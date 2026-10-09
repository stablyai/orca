// Which turn a person's Stop that named no turn binds: one that ends while the Stop settles, and
// the turn its interrupt took. A Stop that stopped nothing binds no turn that opens after it, nor
// does a Stop of a start that never landed; a card it held, which Resume releases, and anything
// sent after it end as their own. Turn rows name the send that opened them, as Codex writes them.

import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const LATER_TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-later',
  ordinal: 999
}

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function stopEvents(): JournalStopEvent[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

function childPhase() {
  return rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase
}

function fence(): number {
  return rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1
}

/** A Stop's second step, which ends the child, runs next on the session's lane. */
function laneDrained(): Promise<void> {
  return rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
}

async function laterTurn() {
  const { items } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
  return items
    .map((item) => readAgentJournalTurn(item.body))
    .find((turn) => turn?.turnId === 'turn-later')
}

/** Every end row written for the later turn, in order, a child end's batch included: a relabel
 *  would show as two. */
function laterTurnEndRows() {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) => {
    const bodies =
      row.kind === 'item'
        ? [row.body]
        : row.kind === 'lifecycle-batch'
          ? row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
          : []
    return bodies.flatMap((body) => {
      const turn = readAgentJournalTurn(body)
      return turn?.turnId === 'turn-later' && turn.state !== 'running' ? [turn] : []
    })
  })
}

/** The turn send `clientMessageId` opens, running, named by its row as Codex writes it. */
async function turnOpenedBy(clientMessageId: string, state: 'running' | 'interrupted' = 'running') {
  await journal().appendItem(
    LATER_TURN,
    {
      kind: 'turn',
      turnId: 'turn-later',
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() + 5 })
    },
    { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
  }
  return queued.value.queued.messageId
}

/** A person's Stop of a start that never landed, whose send opens no turn. `held`: a card queued
 *  behind the start, which the Stop holds. */
async function stopOfStart(options: { held?: true } = {}): Promise<string | undefined> {
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  // Held for a child that never proves its start, so it is never handed over.
  rig.send('work on this')
  await eventually(() => expect(childPhase()).toBe('starting'))
  const held = options.held ? await queuedDraft('queued behind the start') : undefined
  expect(await rig.stop()).toMatchObject({ ok: true })
  expect(stopEvents()).toEqual([expect.objectContaining({ reason: 'user-stop' })])
  expect(stopEvents()[0]).not.toHaveProperty('turnId')
  await eventually(() => expect(childPhase()).toBeUndefined())
  return held
}

/** Orchestration mail after the Stop starts a new child and its turn runs. */
async function mailTurn(): Promise<void> {
  const handedOver = rig.dispatch.mock.calls.length
  const mail = rig.send('mail for the worker')
  await mail.result
  await rig.proveStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(handedOver + 1))
  await turnOpenedBy(mail.id)
}

/** The host evicts the chat; the Stop events as its provider close finds them. */
/** The person's Stop still pauses the reopened chat. The close hides its row, as every close of a
 *  chat does: nothing runs there until its next turn. */
async function stillStopped(): Promise<boolean> {
  expect(await rig.queuePause()).toBeNull()
  return structuredQueuePauses(journal()).some((pause) => pause.reason === 'stopped')
}

async function evictedAt(): Promise<string[]> {
  let atClose: JournalStopEvent[] = []
  rig.closeSession.mockImplementationOnce(async () => {
    // The event is issued before the kill, never awaited by it: the journal writes it ahead of
    // anything the kill makes the child write.
    await new Promise((resolve) => setImmediate(resolve))
    atClose = stopEvents()
    return true
  })
  await rig.host.close(HOST_TEST_SESSION, 'evict')
  return atClose.map((event) => event.reason)
}

async function expectNews(): Promise<void> {
  const turn = await laterTurn()
  expect(turn).toMatchObject({ state: 'interrupted' })
  expect(turn).not.toHaveProperty('outcome')
}

describe('a Stop of a start that never landed binds no later turn', () => {
  it("writes the host's event when it evicts a mail turn, which reads as news", async () => {
    await stopOfStart()
    await mailTurn()

    expect(await evictedAt()).toEqual(['user-stop', 'evict'])
    await expectNews()
  })

  it('reads a mail turn the child end cut, with no verdict of its own, as news', async () => {
    await stopOfStart()
    const mail = rig.send('mail for the worker')
    await mail.result
    await turnOpenedBy(mail.id)

    await turnOpenedBy(mail.id, 'interrupted')

    await expectNews()
  })

  it('settles a crash of a mail turn on relaunch as news', async () => {
    await stopOfStart()
    await mailTurn()
    const owner = fence()
    rig.crashRestartHostProcess()
    await rig.host.journalSnapshot(HOST_TEST_SESSION)

    await settleStaleStructuredAgentSessionState({
      journal: journal(),
      sessionId: HOST_TEST_SESSION,
      fence: owner + 1,
      acquisitionGeneration: 'generation-2',
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'the relaunch proved the old child gone',
        observedAt: Date.now() + 60_000,
        ownerFence: owner
      }
    })

    await expectNews()
  })

  it("writes the host's event when it evicts the turn of a card the Stop held, which Resume sent", async () => {
    const held = (await stopOfStart({ held: true }))!
    expect(await rig.resume()).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
    await turnOpenedBy(await rig.handoffId(held))

    expect(await evictedAt()).toEqual(['user-stop', 'evict'])
    await expectNews()
  })
})

describe('a Stop pressed before its send opened a turn binds only the turn it stopped', () => {
  /** The send the Stop stopped is handed over and unopened; a card waits behind it. */
  async function stopBeforeTheTurnShowed(
    answer: Awaited<ReturnType<QueuedMessageTestRig['cancelTurn']>> = { cancelled: true }
  ): Promise<{ stopped: string; held: string }> {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const stopped = await rig.workingSend()
    const held = await queuedDraft('queued behind the turn')
    rig.cancelTurn.mockResolvedValueOnce(answer)
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    return { stopped, held }
  }

  it('binds the turn its interrupt took, whose end lands after the Stop answered', async () => {
    const { stopped } = await stopBeforeTheTurnShowed({ cancelled: true, turnId: 'turn-later' })
    await rig.settleAccepted(stopped, 'stopped')

    await turnOpenedBy(stopped, 'interrupted')

    expect(await laterTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  // The interrupt reaches the turn as it opens; its end is written before the Stop answers.
  it('reads a turn that ends while the Stop settles as interrupted from its first end row', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    rig.cancelTurn.mockImplementationOnce(async () => {
      await turnOpenedBy(stopped)
      await turnOpenedBy(stopped, 'interrupted')
      return { cancelled: true, turnId: 'turn-later' }
    })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(laterTurnEndRows()).toEqual([
      expect.objectContaining({ state: 'interrupted', outcome: 'cancellation' })
    ])
    expect(journal().activeTurnId()).toBeNull()
  })

  // The provider's answer does not decide the Stop: the child's end does, taking back the send.
  it('binds no turn the next send opens after a Stop the provider said stopped nothing', async () => {
    const { stopped } = await stopBeforeTheTurnShowed({ cancelled: false })
    await laneDrained()
    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    expect(await rig.submission(stopped)).toMatchObject({ dispatchState: 'rejected' })
    const next = await rig.workingSend()

    await turnOpenedBy(next)
    await turnOpenedBy(next, 'interrupted')

    await expectNews()
  })

  it("writes the host's event when it evicts the turn of the card Resume sent", async () => {
    const { held } = await stopBeforeTheTurnShowed()
    // The child's end took the unopened send back; Resume sends the card to the next child.
    await laneDrained()
    expect(await rig.resume()).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(held))?.handedOverAt).toBeDefined())
    await turnOpenedBy(await rig.handoffId(held))

    expect(await evictedAt()).toEqual(['user-stop', 'evict'])
    await expectNews()
  })

  it('reads a mail turn the child end cut as news', async () => {
    const { stopped } = await stopBeforeTheTurnShowed()
    await rig.settleAccepted(stopped, 'stopped')
    const mail = rig.send('mail for the lead')
    await mail.result
    await turnOpenedBy(mail.id)

    await turnOpenedBy(mail.id, 'interrupted')

    await expectNews()
  })
})

describe('a press that writes no Stop event of its own', () => {
  // A turnless Stop long since settled, then a later turn the person's own send opened.
  async function laterTurnAfterAnEarlierStop(): Promise<string> {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const stopped = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    // Its turn never opened, so the child's end took it back; the next send starts a new child.
    await laneDrained()
    expect(await rig.submission(stopped)).toMatchObject({ dispatchState: 'rejected' })
    const sent = await rig.workingSend()
    await rig.settleAccepted(sent, 'sent')
    await turnOpenedBy(sent)
    return sent
  }

  it('reopens no earlier Stop: a late Stop naming a turn already over binds no turn', async () => {
    const sent = await laterTurnAfterAnEarlierStop()
    const earlier = journal().stopMarks.latest()
    rig.cancelTurn.mockImplementationOnce(async () => {
      await turnOpenedBy(sent, 'interrupted')
      return { cancelled: false }
    })

    const late = await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ turnId: 'turn-gone' }, 'agentSession.cancel', hostTestOperationId()),
      turnId: 'turn-gone'
    })

    expect(late).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()).toBe(earlier)
    await expectNews()
  })

  // The event is in the fold by its write's return, so one that failed leaves the earlier Stop latest.
  it('reopens no earlier Stop: a press whose event row failed binds no turn', async () => {
    const sent = await laterTurnAfterAnEarlierStop()
    const earlier = journal().stopMarks.latest()
    vi.spyOn(journal(), 'appendStopEvent').mockRejectedValueOnce(new Error('disk full'))
    rig.cancelTurn.mockImplementationOnce(async () => {
      await turnOpenedBy(sent, 'interrupted')
      return { cancelled: false }
    })

    expect(await rig.stop()).toMatchObject({ ok: true })

    expect(journal().stopMarks.latest()).toBe(earlier)
    await expectNews()
  })
})

describe("a Stop's settle that ends the turn its interrupt took", () => {
  it("ends a turn still running at the Stop's settle, as the Stop's, once", async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    await rig.settleAccepted(stopped, 'stopped')
    await turnOpenedBy(stopped)
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: true, turnId: 'turn-later' })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    expect(laterTurnEndRows()).toEqual([
      expect.objectContaining({ state: 'interrupted', outcome: 'cancellation' })
    ])
    expect(journal().activeTurnId()).toBeNull()
  })
})

describe('a host stop with no turn running after a Stop that named none', () => {
  // The Stop settles until its next step has ended the child.
  it('defers to that Stop while it settles, and not after', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    let whileSettling: boolean | undefined
    rig.cancelTurn.mockImplementationOnce(async () => {
      whileSettling = journal().stopMarks.personStopDecides(null)
      return { cancelled: true }
    })

    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.personStopDecides(null)).toBe(true)
    await laneDrained()

    expect(whileSettling).toBe(true)
    expect(journal().stopMarks.personStopDecides(null)).toBe(false)
  })

  it.each([
    ['stopped nothing', { cancelled: false }],
    ['took', { cancelled: true }]
  ] as const)(
    'writes nothing while the Stop, which %s, still pauses the queue, and the card stays held',
    async (_, answer) => {
      rig = await createQueuedMessageTestRig()
      await rig.workingSend()
      const card = await queuedDraft('queued behind the send')
      rig.cancelTurn.mockResolvedValueOnce(answer)
      expect(await rig.stop()).toMatchObject({ ok: true })
      expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')

      expect(await evictedAt()).toEqual(['user-stop'])
      expect(await stillStopped()).toBe(true)
      expect(await rig.handoff(card)).toBeUndefined()
    }
  )

  // Codex could not reach a turn still able to open, and its process could not be ended.
  it('writes nothing after a Stop whose kill failed, and the card stays held', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const card = await queuedDraft('queued behind the send')
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: { turnMayOpen: true } })
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    // The Stop answers before its next step tries to end the child.
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()
    expect(rig.closeSession).toHaveBeenCalledTimes(1)

    expect(await evictedAt()).toEqual(['user-stop'])
    expect(await stillStopped()).toBe(true)
    expect(await rig.handoff(card)).toBeUndefined()
  })

  it("writes the host's event when a send after the Stop is unanswered beside the stopped one", async () => {
    rig = await createQueuedMessageTestRig({ restartable: true, windsDown: true })
    const stopped = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    // The stopped send's turn opens after that turnless Stop, and ends interrupted, unanswered,
    // while the child winds down; the mail then reaches the next child.
    await openRigTurnFor(rig, stopped)
    await openRigTurnFor(rig, stopped, 'interrupted')
    await laneDrained()
    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    const mail = rig.send('mail for the lead')
    await mail.result
    await eventually(async () =>
      expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined()
    )

    expect(await evictedAt()).toEqual(['user-stop', 'evict'])
  })
})

describe('a rewind that restates a turnless Stop', () => {
  // The rewind writes the Stop still in force after the turns it keeps, at a new position; the
  // mail after the rewind is still its own.
  it('binds no turn opened after the rewind', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    await rig.settleAccepted(stopped, 'stopped')
    const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    const stoppedTurn = { ...LATER_TURN, turnId: 'turn-stopped', ordinal: 998 }
    const ended = {
      kind: 'turn' as const,
      turnId: 'turn-stopped',
      state: 'interrupted' as const,
      userItemId: agentJournalSubmissionKey(stopped)
    }
    await journal().appendItem(
      stoppedTurn,
      { ...ended, state: 'running', startedAt: Date.now() },
      scope
    )
    await journal().appendItem(stoppedTurn, { ...ended, completedAt: Date.now() + 1 }, scope)

    await journal().replaceEpochItems('handle_forked', 1, [
      {
        identity: stoppedTurn,
        body: { ...ended, completedAt: Date.now() + 1, outcome: 'cancellation' }
      }
    ])
    const mail = rig.send('mail after the rewind')
    await mail.result
    await turnOpenedBy(mail.id)
    await turnOpenedBy(mail.id, 'interrupted')

    await expectNews()
  })
})
