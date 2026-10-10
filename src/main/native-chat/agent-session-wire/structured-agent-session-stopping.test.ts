// The host's "Stopping…": published on the session's status while a person's Stop is still
// settling, and then while the turn it stopped, or failed to stop, still runs, until that turn ends.
// Every chat Stop ends the child in its next step on the session's lane. Driven through the real
// host and its status feed, with turn rows named as Codex writes them.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import {
  isStructuredAgentSessionStopNote,
  structuredAgentSessionStopNoteIdentity
} from './structured-agent-session-command-turn'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import type { QueuedRigProviderOptions } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function fence(): number {
  return rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1
}

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 }
}

/** Turn `turnId`, opened by send `clientMessageId`, running or ended as the provider cut it. */
async function turn(turnId: string, clientMessageId: string, state: 'running' | 'interrupted') {
  await journal().appendItem(
    turnIdentity(turnId),
    {
      kind: 'turn',
      turnId,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() + 5 })
    },
    { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** The session's summaries as a session list receives them. */
function watchStatus(): () => AgentSessionStatusSummary | undefined {
  const events: AgentSessionStatusEvent[] = []
  rig.host.subscribeStatus({ id: 'list', emit: (event) => events.push(event) })
  return () => {
    for (const event of events.toReversed()) {
      if (event.type === 'status' && event.session.sessionId === HOST_TEST_SESSION) {
        return event.session
      }
      if (event.type === 'snapshot') {
        return event.sessions.find((session) => session.sessionId === HOST_TEST_SESSION)
      }
    }
    return undefined
  }
}

/** The Stop as the phone sends it, naming the turn its journal shows running. */
function namedStop(turnId: string) {
  return rig.host.cancel(QUEUED_RIG_CALLER, {
    envelope: rig.envelope({ turnId }, 'agentSession.cancel', hostTestOperationId()),
    turnId
  })
}

/** What each Stop answered, oldest first. */
function stopAnswers(): (string | undefined)[] {
  return journal()
    .snapshot()
    .items.filter((item) => isStructuredAgentSessionStopNote(item.itemId))
    .map((item) => (item.body.kind === 'status' ? (item.body.failure?.kind ?? 'took') : undefined))
}

/** The Stop's next step on the session's lane, where it ends the child, has run. */
async function laneDrained(): Promise<void> {
  await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
}

/** A send whose turn `turn-1` is running, and the session's status. */
async function runningTurn(options: QueuedRigProviderOptions = {}) {
  rig = await createQueuedMessageTestRig(options)
  const sent = await rig.workingSend()
  await rig.settleAccepted(sent, 'sent')
  await turn('turn-1', sent, 'running')
  const status = watchStatus()
  await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
  expect(status()).not.toHaveProperty('stopping')
  return { sent, status }
}

describe("a person's Stop reads Stopping until the work it stopped ends", () => {
  it('reads Stopping once the Stop takes effect, and clears when the turn ends', async () => {
    const { sent, status } = await runningTurn()

    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))

    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    expect(status()).not.toHaveProperty('stopping')
  })

  it('reads Stopping before the agent answers the interrupt', async () => {
    const { status } = await runningTurn()
    let answer: (outcome: AgentSessionCancelOutcome) => void = () => undefined
    rig.cancelTurn.mockImplementationOnce(
      () => new Promise<AgentSessionCancelOutcome>((resolve) => (answer = resolve))
    )

    const stopped = rig.stop()
    await eventually(() => expect(status()).toMatchObject({ stopping: true }))

    answer({ cancelled: true })
    expect(await stopped).toMatchObject({ ok: true })
    expect(status()).toMatchObject({ stopping: true })
  })

  const refused = async (): Promise<AgentSessionCancelOutcome> => ({ cancelled: false })
  const unconfirmed = async (): Promise<AgentSessionCancelOutcome> => {
    throw new Error('the interrupt request timed out')
  }
  it.each([
    ['refused', 'names no turn', refused],
    ['left unconfirmed', 'names no turn', unconfirmed],
    ['left unconfirmed', 'names the turn', unconfirmed]
  ])(
    'keeps Stopping until the turn ends after the agent %s a Stop that %s, whose child end failed',
    async (_, naming, cancel) => {
      const { sent, status } = await runningTurn()
      rig.cancelTurn.mockImplementationOnce(cancel)
      // The Stop ends the agent's process next; this one cannot be ended.
      rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))

      const stopped = naming === 'names the turn' ? namedStop('turn-1') : rig.stop()
      expect(await stopped).toMatchObject({ ok: true })
      await laneDrained()

      // The note says the Stop is unconfirmed, yet it is still the person's: a repeat escalates.
      expect(stopAnswers()).toEqual(['cancelUnconfirmed'])
      expect(status()).toMatchObject({ status: 'working', stopping: true })

      await turn('turn-1', sent, 'interrupted')
      await eventually(() => expect(status()?.status).toBe('idle'))
      expect(status()).not.toHaveProperty('stopping')
    }
  )

  it.each([
    [
      'refuses',
      async (): Promise<AgentSessionCancelOutcome> => ({ cancelled: false, refusal: {} })
    ],
    ['never answers', unconfirmed]
  ])(
    'ends the agent when it %s a Stop naming the running turn, so Stopping ends with the turn',
    async (_, cancel) => {
      const { status } = await runningTurn()
      rig.cancelTurn.mockImplementationOnce(cancel)

      expect(await namedStop('turn-1')).toMatchObject({ ok: true })

      await eventually(() => expect(rig.closeSession).toHaveBeenCalled())
      await eventually(() => expect(status()?.status).not.toBe('working'))
      expect(status()).not.toHaveProperty('stopping')
    }
  )

  it('keeps Stopping through a repeat press of a refused Stop, which writes no second event', async () => {
    const { status } = await runningTurn()
    rig.cancelTurn.mockImplementationOnce(async () => ({ cancelled: false }))
    // Neither the Stop's end of the child nor the repeat's joined close proves the exit.
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out again'))
    expect(await rig.stop()).toMatchObject({ ok: true })
    await laneDrained()
    expect(journal().stopMarks.latest()).not.toBeNull()
    const refusedStop = journal().stopMarks.latest()

    expect(await rig.stop()).toMatchObject({ ok: true })
    await laneDrained()

    expect(rig.closeSession).toHaveBeenCalledTimes(2)
    expect(journal().stopMarks.latest()).toEqual(refusedStop)
    expect(status()).toMatchObject({ status: 'working', stopping: true })
  })

  // The newest turn record is the stopped one until the next send's turn opens; it no longer runs.
  // That send runs on the child that resumes the chat once the Stop's wind-down ended the old one.
  it.each(['names its turn', 'names no turn'])(
    'reads a send made after a Stop that %s as Working before its turn opens',
    async (naming) => {
      rig = await createQueuedMessageTestRig({ restartable: true, windsDown: true })
      const stopped = await rig.workingSend()
      const status = watchStatus()
      if (naming === 'names its turn') {
        await rig.settleAccepted(stopped, 'stopped')
        await turn('turn-1', stopped, 'running')
        await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
        expect(await namedStop('turn-1')).toMatchObject({ ok: true })
      } else {
        // The provider's answer names the turn the send opened, which the Stop waited for.
        rig.cancelTurn.mockImplementationOnce(async () => {
          await rig.settleAccepted(stopped, 'stopped')
          await turn('turn-1', stopped, 'running')
          return { cancelled: true, turnId: 'turn-1' }
        })
        expect(await rig.stop()).toMatchObject({ ok: true })
      }
      await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))
      await turn('turn-1', stopped, 'interrupted')
      await eventually(() => expect(status()?.status).toBe('idle'))
      await laneDrained()
      expect(rig.closeSession).toHaveBeenCalledOnce()

      await rig.workingSend()

      await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
      expect(status()).not.toHaveProperty('stopping')
    }
  )

  it('never marks a turn that opened after the stopped one ended', async () => {
    const { sent, status } = await runningTurn({ restartable: true, windsDown: true })
    expect(await rig.stop()).toMatchObject({ ok: true })
    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    await laneDrained()
    expect(rig.closeSession).toHaveBeenCalledOnce()

    const next = await rig.workingSend()
    await rig.settleAccepted(next, 'next')
    await turn('turn-2', next, 'running')

    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')
  })
})

describe('a Stop that failed before the turn it meant to stop opened', () => {
  /** Its end, with no verdict of its own, read off the journal. */
  function turnEnd(turnId: string) {
    return journal()
      .snapshot()
      .items.map((item) => item.body)
      .find((body) => body.kind === 'turn' && body.turnId === turnId)
  }

  async function failedBeforeTheTurn(options: { tookInterrupt?: true; restartable?: true } = {}) {
    rig = await createQueuedMessageTestRig(options.restartable ? { restartable: true } : {})
    const sent = await rig.workingSend()
    const status = watchStatus()
    if (!options.tookInterrupt) {
      // Codex could not reach a turn still able to open.
      rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: { turnMayOpen: true } })
    }
    // The process could not be ended either.
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    expect(await rig.stop()).toMatchObject({ ok: true })
    await laneDrained()
    expect(journal().activeTurnId()).toBeNull()
    return { sent, status }
  }

  it.each([
    ['refused, then its kill failed', {}],
    ['taken, whose kill failed before the echo', { tookInterrupt: true as const }]
  ])(
    'reads Stopping through the turn that then opens, whose own end stays its own: %s',
    async (_, options) => {
      const { sent, status } = await failedBeforeTheTurn(options)
      await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))

      await rig.settleAccepted(sent, 'sent')
      await turn('turn-1', sent, 'running')
      await eventually(() => expect(journal().activeTurnId()).toBe('turn-1'))
      expect(status()).toMatchObject({ status: 'working', stopping: true })
      await turn('turn-1', sent, 'interrupted')
      await eventually(() => expect(status()?.status).toBe('idle'))

      expect(status()).not.toHaveProperty('stopping')
      expect(turnEnd('turn-1')).toMatchObject({ state: 'interrupted' })
      expect(turnEnd('turn-1')).not.toHaveProperty('outcome')
    }
  )

  it("never reads Stopping on a send's turn handed over after it", async () => {
    // A later send needs a child again once the failed end is retried.
    const { sent, status } = await failedBeforeTheTurn({ restartable: true })
    await rig.settleRejected(sent, 'no turn for this one')
    await eventually(() => expect(status()?.status).not.toBe('working'))

    const later = await rig.workingSend()
    await rig.settleAccepted(later, 'later')
    await turn('turn-2', later, 'running')

    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')
  })
})

describe("a Stop's settle edge", () => {
  // It writes no row: it republishes the status and wakes the handover, and is no activity.
  it('republishes Stopping without counting as activity', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const status = watchStatus()
    await journal().appendStopEvent({ reason: 'user-stop' }, fence())
    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    const sessions = rig.host.collaboratorsForTests().sessions
    const touch = vi.spyOn(sessions, 'touch')

    const settle = journal().stopMarks.beginSettle()
    await eventually(() => expect(status()).toMatchObject({ stopping: true }))
    journal().stopMarks.settled(settle)
    await eventually(() => expect(status()).not.toHaveProperty('stopping'))

    expect(touch).not.toHaveBeenCalled()
  })
})

describe('a Stop pressed before its send opened a turn', () => {
  /** A Stop pressed before the send's turn showed, which opens while the Stop waits for it. */
  async function stopAsTheTurnOpens(answer: AgentSessionCancelOutcome, killFails?: true) {
    rig = await createQueuedMessageTestRig()
    if (killFails) {
      rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    }
    const sent = await rig.workingSend()
    const status = watchStatus()
    rig.cancelTurn.mockImplementationOnce(async () => {
      await rig.settleAccepted(sent, 'sent')
      await turn('turn-1', sent, 'running')
      return answer
    })
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    await laneDrained()
    return { sent, status }
  }

  function turnOne() {
    return journal()
      .snapshot()
      .items.map((item) => item.body)
      .find((body) => body.kind === 'turn' && body.turnId === 'turn-1')
  }

  it('ends the turn its interrupt took with the child, and Stopping with it', async () => {
    const { status } = await stopAsTheTurnOpens({ cancelled: true, turnId: 'turn-1' })

    expect(rig.closeSession).toHaveBeenCalledOnce()
    expect(journal().activeTurnId()).toBeNull()
    expect(turnOne()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    await eventually(() => expect(status()?.status).toBe('idle'))
    expect(status()).not.toHaveProperty('stopping')
  })

  it('holds Stopping through the turn a Stop that failed could not stop, until that turn ends', async () => {
    // The agent refused, and its process could not be ended either.
    const { sent, status } = await stopAsTheTurnOpens({ cancelled: false, refusal: {} }, true)

    await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))
    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    expect(status()).not.toHaveProperty('stopping')
    // The Stop never stopped it: its own end, with no verdict, reads as a failure, not theirs.
    expect(turnOne()).toMatchObject({ state: 'interrupted' })
    expect(turnOne()).not.toHaveProperty('outcome')
  })

  // Declined, the Stop still ends the child, whose end takes the send back: the send's own row says
  // it never started, so the Stop writes none.
  it('reads Stopping while the Stop settles, and at rest once a declined Stop ended the child', async () => {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    const status = watchStatus()
    const answer = Promise.withResolvers<AgentSessionCancelOutcome>()
    rig.cancelTurn.mockImplementationOnce(() => answer.promise)

    const stopped = rig.stop()
    await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))
    answer.resolve({ cancelled: false })
    expect(await stopped).toMatchObject({ ok: true })
    await laneDrained()

    expect(rig.closeSession).toHaveBeenCalledOnce()
    expect(await rig.submission(sent)).toMatchObject({ dispatchState: 'rejected' })
    expect(stopAnswers()).toEqual([])
    await eventually(() => expect(status()?.status).not.toBe('working'))
    expect(status()).not.toHaveProperty('stopping')
  })

  it('reads a send made after the Stop as Working', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true, windsDown: true })
    const stopped = await rig.workingSend()
    const status = watchStatus()
    expect(await rig.stop()).toMatchObject({ ok: true })
    // The interrupted send's turn shows, ended, while the Stop's wind-down waits on it.
    await rig.settleAccepted(stopped, 'stopped')
    await turn('turn-1', stopped, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    await laneDrained()
    expect(rig.closeSession).toHaveBeenCalledOnce()

    const later = await rig.workingSend()
    await rig.settleAccepted(later, 'later')
    await turn('turn-2', later, 'running')

    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')
  })
})

describe('a Stop whose end of the child fails', () => {
  it("revises the note a Stop pressed before its turn showed wrote, once that turn opened and the child's end failed", async () => {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    const status = watchStatus()
    const kill = Promise.withResolvers<boolean>()
    rig.closeSession.mockImplementationOnce(() => kill.promise)
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(rig.closeSession).toHaveBeenCalled())

    await rig.settleAccepted(sent, 'sent')
    await turn('turn-1', sent, 'running')
    kill.reject(new Error('the kill timed out'))

    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))
    expect(status()).toMatchObject({ status: 'working', stopping: true })
  })

  it("says the Stop went unconfirmed once the child's end fails, and that it took once the next Stop's joined close proves the exit", async () => {
    const { status } = await runningTurn()
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))

    expect(await rig.stop()).toMatchObject({ ok: true })

    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))
    // Still the person's Stop while the work runs on: Stop stays enabled for the retry.
    expect(status()).toMatchObject({ status: 'working', stopping: true })

    // The retry's child end is held, so the status can be read while it runs. The retry joins the
    // child's close, which runs the stop again since the last one came back unproven.
    const retried = Promise.withResolvers<boolean>()
    rig.closeSession.mockImplementationOnce(() => retried.promise)
    const retry = rig.stop()
    await eventually(() => expect(rig.closeSession).toHaveBeenCalledTimes(2))
    expect(status()).toMatchObject({ status: 'working', stopping: true })
    retried.resolve(true)
    expect(await retry).toMatchObject({ ok: true })
    expect(stopAnswers()).toEqual(['took'])
  })

  it('keeps the note unconfirmed when the next Stop joins a close that fails again', async () => {
    const { status } = await runningTurn()
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))

    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out again'))
    expect(await rig.stop()).toMatchObject({ ok: true })

    expect(rig.closeSession).toHaveBeenCalledTimes(2)
    expect(stopAnswers()).toEqual(['cancelUnconfirmed'])
    expect(status()).toMatchObject({ status: 'working', stopping: true })
  })

  // The close lives on the child, in memory, and dies with the host. The new host's settlement,
  // which ends the turn on a proof of the old owner's death, is what says the Stop took.
  async function crashAfterUnconfirmedStop(): Promise<void> {
    await runningTurn()
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))
    rig.crashRestartHostProcess()
  }

  function turnOneState(): string | undefined {
    return journal()
      .snapshot()
      .items.map((item) => (item.body.kind === 'turn' ? item.body : undefined))
      .find((turn) => turn?.turnId === 'turn-1')?.state
  }

  /** What the host's restart reconciliation or recovery writes once a probe finds the old pid gone. */
  async function proveOldOwnerGone(): Promise<void> {
    const record = rig.store.getRecord(HOST_TEST_SESSION)!
    await rig.store.evictProvenDeadOwner({
      sessionId: HOST_TEST_SESSION,
      expectedFence: record.lease.runtimeFence,
      probe: { outcome: 'pid-absent' },
      now: Date.now()
    })
  }

  it("says the Stop took once the new host proves the old child's exit after a crash", async () => {
    await crashAfterUnconfirmedStop()
    // Proven before the chat opens, as the restart's reconciliation does on most machines.
    await proveOldOwnerGone()
    await rig.queuePause()

    expect({ turn: turnOneState(), notes: stopAnswers() }).toEqual({
      turn: 'interrupted',
      notes: ['took']
    })
  })

  it('keeps the note unconfirmed while the old exit stays unverifiable, then says it took once proven', async () => {
    await crashAfterUnconfirmedStop()
    await rig.queuePause()
    expect({ turn: turnOneState(), notes: stopAnswers() }).toEqual({
      turn: 'unverifiable',
      notes: ['cancelUnconfirmed']
    })

    // A later proof naming the old owner, as recovery writes it, revises the open chat.
    await proveOldOwnerGone()
    await eventually(() =>
      expect({ turn: turnOneState(), notes: stopAnswers() }).toEqual({
        turn: 'interrupted',
        notes: ['took']
      })
    )
  })

  // A Stop pressed before its turn showed keys its note by itself, with no turn to sit on; once it is
  // unconfirmed while that turn runs, the note moves onto the turn, so the turn's proven end finds it.
  it('moves a note a Stop wrote before its turn showed onto that turn, which then says the Stop took', async () => {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    const kill = Promise.withResolvers<boolean>()
    rig.closeSession.mockImplementationOnce(() => kill.promise)
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(rig.closeSession).toHaveBeenCalled())
    await rig.settleAccepted(sent, 'sent')
    await turn('turn-1', sent, 'running')
    kill.reject(new Error('the kill timed out'))
    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))

    // A join that fails again neither adds a note nor brings the first one back.
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out again'))
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(stopAnswers()).toEqual(['cancelUnconfirmed'])

    // The next Stop's joined close proves the exit.
    expect(await rig.stop()).toMatchObject({ ok: true })

    await eventually(() => expect(stopAnswers()).toEqual(['took']))
    const turnRecord = journal()
      .snapshot()
      .items.find((item) => item.body.kind === 'turn' && item.body.turnId === 'turn-1')
    const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    const notes = page.ok
      ? page.page.items.filter((item) => isStructuredAgentSessionStopNote(item.itemId))
      : []
    // What a client loads: one note, on that turn.
    expect(notes.map((item) => [item.itemId, item.turnScope])).toEqual([
      [
        agentJournalItemKey(structuredAgentSessionStopNoteIdentity('turn-1')),
        { kind: 'turn', turnItemId: turnRecord?.itemId }
      ]
    ])
  })

  // The kill timed out, then the agent's process exits on its own: the adapter reports the end of
  // the close Orca began, and nothing else asks to stop.
  it("says the Stop took once the agent's process exits on its own after the kill timed out", async () => {
    await runningTurn()
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))

    await rig.host.handleAdapterEvent({
      type: 'ended',
      sessionId: HOST_TEST_SESSION,
      reason: 'claude session closed',
      cause: 'requested-close',
      fence: fence(),
      acquisitionGeneration: 'generation-1',
      observedAt: Date.now()
    })

    await eventually(() =>
      expect(
        rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child ?? null
      ).toBeNull()
    )
    expect({ turn: turnOneState(), notes: stopAnswers() }).toEqual({
      turn: 'interrupted',
      notes: ['took']
    })
  })
})
