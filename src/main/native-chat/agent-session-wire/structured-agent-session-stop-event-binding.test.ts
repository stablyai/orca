// Which turn a person's Stop that named no turn binds: only a turn a send it stopped opens. A Stop
// of a start that never landed stopped a send that opens no turn; a card it held, which Resume
// releases, and anything sent after it open their own; a rewind keeps the binding. Turn rows name
// the send that opened them, as Codex writes them.

import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

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
  let release: () => void = () => undefined
  rig.awaitStarted.mockImplementation(
    () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
  )
  rig.send('work on this')
  await eventually(() => expect(childPhase()).toBe('starting'))
  const held = options.held ? await queuedDraft('queued behind the start') : undefined
  expect(await rig.stop()).toMatchObject({ ok: true })
  release()
  expect(stopEvents()).toEqual([expect.objectContaining({ reason: 'user-stop' })])
  expect(stopEvents()[0]).not.toHaveProperty('turnId')
  await eventually(() => expect(childPhase()).toBeUndefined())
  rig.awaitStarted.mockImplementation(async () => undefined)
  return held
}

/** Orchestration mail after the Stop starts a new child and its turn runs. */
async function mailTurn(): Promise<void> {
  const mail = rig.send('mail for the worker', undefined, { internal: true })
  await mail.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalled())
  await turnOpenedBy(mail.id)
}

/** The host evicts the chat; the Stop events as its provider close finds them. */
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
    const mail = rig.send('mail for the worker', undefined, { internal: true })
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

describe('a Stop pressed before its send opened a turn binds only that turn', () => {
  /** The send the Stop stopped is handed over and unopened; a card waits behind it. */
  async function stopBeforeTheTurnShowed(): Promise<{ stopped: string; held: string }> {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    const held = await queuedDraft('queued behind the turn')
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    return { stopped, held }
  }

  it("binds the stopped send's own turn", async () => {
    const { stopped } = await stopBeforeTheTurnShowed()
    await rig.settleAccepted(stopped, 'stopped')

    await turnOpenedBy(stopped, 'interrupted')

    expect(await laterTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
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
    const mail = rig.send('mail for the lead', undefined, { internal: true })
    await mail.result
    await turnOpenedBy(mail.id)

    await turnOpenedBy(mail.id, 'interrupted')

    await expectNews()
  })
})

describe('a host stop with no turn running after a Stop that named none', () => {
  it('writes nothing while every unanswered send is one the Stop stopped', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')

    expect(await evictedAt()).toEqual(['user-stop'])
  })

  it("writes the host's event when a send after the Stop is unanswered beside the stopped one", async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    const mail = rig.send('mail for the lead', undefined, { internal: true })
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
    const mail = rig.send('mail after the rewind', undefined, { internal: true })
    await mail.result
    await turnOpenedBy(mail.id)
    await turnOpenedBy(mail.id, 'interrupted')

    await expectNews()
  })
})
