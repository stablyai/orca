import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'
import { structuredAgentSessionNamedTurnScope } from './structured-agent-session-turn-stop-notes'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  openRigTurnFor,
  withdrawnByStop
} from './structured-agent-session-queued-rig-turn.test-fixture'

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

async function laterTurn() {
  const { items } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
  return items
    .map((item) => readAgentJournalTurn(item.body))
    .find((turn) => turn?.turnId === 'turn-later')
}

function laterTurnEndRows() {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) => {
    const turn = row.kind === 'item' ? readAgentJournalTurn(row.body) : undefined
    return turn?.turnId === 'turn-later' && turn.state !== 'running' ? [turn] : []
  })
}

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

async function stopOfStart(options: { held?: true } = {}): Promise<string | undefined> {
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  rig.send('work on this')
  await eventually(() => expect(childPhase()).toBe('starting'))
  const held = options.held ? await queuedDraft('queued behind the start') : undefined
  expect(await rig.stop()).toMatchObject({ ok: true })
  expect(stopEvents()).toEqual([expect.objectContaining({ reason: 'user-stop' })])
  expect(stopEvents()[0]).not.toHaveProperty('turnId')
  await eventually(() => expect(childPhase()).toBeUndefined())
  return held
}

async function mailTurn(): Promise<void> {
  const handedOver = rig.dispatch.mock.calls.length
  const mail = rig.send('mail for the retry')
  await mail.result
  await rig.proveStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(handedOver + 1))
  await turnOpenedBy(mail.id)
}

/** Close hides the pause row while preserving the derived personal Stop hold. */
async function stillStopped(): Promise<boolean> {
  expect(await rig.queuePause()).toBeNull()
  return structuredQueuePauses(journal()).some((pause) => pause.reason === 'stopped')
}

async function evictedAt(): Promise<string[]> {
  let atClose: JournalStopEvent[] = []
  rig.closeSession.mockImplementationOnce(async () => {
    // Yield until the pre-kill event lands ahead of child-generated rows.
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
    const mail = rig.send('mail for the retry')
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

describe('a Stop naming no turn binds the turn live as its event is written', () => {
  const FIRST_TURN: AgentJournalItemIdentity = { ...LATER_TURN, turnId: 'turn-first', ordinal: 998 }

  function firstTurn(state: 'running' | 'completed') {
    return journal().appendItem(
      FIRST_TURN,
      {
        kind: 'turn',
        turnId: 'turn-first',
        startedAt: 1,
        ...(state === 'running' ? { state } : { state, completedAt: 2 })
      },
      { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }

  it('names and binds the turn that opened while its save waited, never the one before', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    await firstTurn('running')
    const saving = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const accept = JournalStopAcceptor.prototype.accept
    const held = vi
      .spyOn(JournalStopAcceptor.prototype, 'accept')
      .mockImplementation(async function (this: JournalStopAcceptor, ...args) {
        entered.resolve()
        await saving.promise
        return accept.apply(this, args)
      })
    const stopping = rig.stop()
    await entered.promise
    await firstTurn('completed')
    await turnOpenedBy(working)
    saving.resolve()

    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    held.mockRestore()
    expect(stopEvents()).toEqual([expect.objectContaining({ turnId: 'turn-later' })])
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    const note = journal()
      .snapshot()
      .items.find((item) => item.body.kind === 'status')
    expect(note?.turnScope).toEqual(structuredAgentSessionNamedTurnScope(journal(), 'turn-later'))
    const snapshot = await rig.host.journalSnapshot(HOST_TEST_SESSION)
    expect(structuredAgentSessionStopping(journal(), snapshot.items, journal().submissions())).toBe(
      true
    )
    await turnOpenedBy(working, 'interrupted')
    expect(laterTurnEndRows()).toEqual([
      expect.objectContaining({ state: 'interrupted', outcome: 'cancellation' })
    ])
    const { items } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
    const first = items
      .map((item) => readAgentJournalTurn(item.body))
      .find((turn) => turn?.turnId === 'turn-first')
    expect(first).toMatchObject({ state: 'completed' })
    expect(first).not.toHaveProperty('outcome', 'cancellation')
  })
})

describe('a Stop pressed before its send opened a turn binds only the turn it stopped', () => {
  async function stopBeforeTheTurnShowed(
    answer: Awaited<ReturnType<QueuedMessageTestRig['cancelTurn']>> = { cancelled: true }
  ): Promise<{ stopped: string; held: string }> {
    rig = await createQueuedMessageTestRig()
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
    expect(journal().runningTurn()?.turnId ?? null).toBeNull()
  })

  it('binds no turn that opens after a Stop that stopped nothing', async () => {
    const { stopped } = await stopBeforeTheTurnShowed({ cancelled: false })
    await rig.settleAccepted(stopped, 'stopped')

    await turnOpenedBy(stopped)
    await turnOpenedBy(stopped, 'interrupted')

    await expectNews()
  })

  it("writes the host's event when it evicts the turn of the card Resume sent", async () => {
    const { stopped, held } = await stopBeforeTheTurnShowed()
    await rig.settleAccepted(stopped, 'stopped')
    expect(await rig.resume()).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
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
  async function laterTurnAfterAnEarlierStop(): Promise<string> {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    await withdrawnByStop(rig, stopped)
    const sent = await rig.workingSend()
    await rig.settleAccepted(sent, 'sent')
    await turnOpenedBy(sent)
    return sent
  }

  it('reopens no earlier Stop: a late Stop naming a turn already over interrupts nothing', async () => {
    await laterTurnAfterAnEarlierStop()
    const earlier = journal().stopMarks.latest()
    const interrupts = rig.cancelTurn.mock.calls.length

    const late = await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ turnId: 'turn-gone' }, 'agentSession.cancel', hostTestOperationId()),
      turnId: 'turn-gone'
    })

    expect(late).toMatchObject({ ok: true, value: { turnId: 'turn-gone', cancelled: false } })
    expect(rig.cancelTurn).toHaveBeenCalledTimes(interrupts)
    expect(journal().stopMarks.latest()).toBe(earlier)
    expect(await laterTurn()).toMatchObject({ state: 'running' })
  })

  it('reopens no earlier Stop: a press whose acceptance failed interrupts nothing', async () => {
    await laterTurnAfterAnEarlierStop()
    const earlier = journal().stopMarks.latest()
    const interrupts = rig.cancelTurn.mock.calls.length
    vi.spyOn(journal().stops, 'accept').mockRejectedValueOnce(new Error('disk full'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await rig.stop()).toMatchObject({ ok: false })

    expect(rig.cancelTurn).toHaveBeenCalledTimes(interrupts)
    expect(journal().stopMarks.latest()).toBe(earlier)
    expect(await laterTurn()).toMatchObject({ state: 'running' })
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

    expect(await laterTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(journal().runningTurn()?.turnId ?? null).toBeNull()
  })
})

describe('a host stop with no turn running after a Stop that named none', () => {
  it('defers to that Stop while it settles, and not after', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    let whileSettling: boolean | undefined
    rig.cancelTurn.mockImplementationOnce(async () => {
      whileSettling = journal().stopMarks.personStopDecides(null)
      return { cancelled: true }
    })

    expect(await rig.stop()).toMatchObject({ ok: true })

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

  it('writes nothing after a Stop whose kill failed, and the card stays held', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const card = await queuedDraft('queued behind the send')
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: { turnMayOpen: true } })
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })

    expect(await evictedAt()).toEqual(['user-stop'])
    expect(await stillStopped()).toBe(true)
    expect(await rig.handoff(card)).toBeUndefined()
  })

  it("writes the host's event when a send after the Stop is unanswered beside the stopped one", async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await openRigTurnFor(rig, stopped)
    await openRigTurnFor(rig, stopped, 'interrupted')
    const mail = rig.send('mail for the lead')
    await mail.result
    await eventually(async () =>
      expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined()
    )

    expect(await evictedAt()).toEqual(['user-stop', 'evict'])
  })
})

describe('a rewind that restates a turnless Stop', () => {
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
        body: { ...ended, completedAt: Date.now() + 1, outcome: 'cancellation' },
        ownerFence: 1
      }
    ])
    const mail = rig.send('mail after the rewind')
    await mail.result
    await turnOpenedBy(mail.id)
    await turnOpenedBy(mail.id, 'interrupted')

    await expectNews()
  })
})
