import { isolateJournalTransition } from './journal-reducer-transition'
import { applyJournalRow } from './journal-reducer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'
import { activeCancellations, normalizeStopCancellations } from './journal-stop-cancellation'
import { it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { restoreJournal, startJournalRowFold } from './journal-open'
import { projectionBase, projectionEpochRow } from './journal-projection-test-support'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { personStopDecidesTurn } from './journal-stop-turn-end'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
async function fixture(now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'pr37743-local-repair-'))
  const journals = createTrackedJournalOpener()
  const sessionId = 'pr37743-local-repair'
  const input = {
    identity: {
      sessionId,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root,
    ...(now ? { now } : {})
  }
  let journal = await journals.open(input)
  return {
    sessionId,
    get db() {
      return openTestJournalHostDatabase(root).db
    },
    get journal() {
      return journal
    },
    restart: async () => {
      await journals.closeAll()
      journal = await journals.open(input)
    },
    dispose: async () => {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
}
const identity = (id: string) => ({
  provider: 'claude' as const,
  sessionId: 'thread',
  uuid: `turn-${id}`
})
async function turn(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  state: 'running' | 'interrupted' = 'running'
) {
  await f.journal.appendItem(
    identity(id),
    { kind: 'turn', turnId: id, state },
    { fence: 0, turnScope: { kind: 'thread' } }
  )
}
function pending(f: Awaited<ReturnType<typeof fixture>>) {
  return f.journal.stopMarks.cancellations()
}
function terminal(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return f.journal.snapshot().items.find((i) => i.body.kind === 'turn' && i.body.turnId === id)
    ?.body
}

it('completed Stops retire at N and 10N, and the next Stop performs the same database work', async () => {
  const work: number[] = []
  const visits: number[] = []
  for (const n of [40, 400]) {
    const f = await fixture()
    try {
      for (let i = 0; i < n; i++) {
        const id = `open-${i}`
        await f.journal.appendSubmission({
          clientMessageId: id,
          payloadFingerprint: id,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
          fence: 0,
          handoverRecorded: true
        })
        await f.journal.resolveDispatch({
          clientMessageId: id,
          state: 'pending',
          fence: 0,
          turnScope: { kind: 'thread' }
        })
        await f.journal.appendItem(
          identity(`A${i}`),
          {
            kind: 'turn',
            turnId: `A${i}`,
            state: 'running',
            userItemId: agentJournalSubmissionKey(id)
          },
          { fence: 0, turnScope: { kind: 'thread' } }
        )
        await f.journal.appendStopEvent({ reason: 'user-stop', turnId: `A${i}` }, 0)
        await f.journal.appendItem(
          identity(`A${i}`),
          {
            kind: 'turn',
            turnId: `A${i}`,
            state: 'interrupted',
            userItemId: agentJournalSubmissionKey(id)
          },
          { fence: 0, turnScope: { kind: 'thread' } }
        )
        await f.journal.resolveDispatch({
          clientMessageId: id,
          state: 'unknown',
          fence: 0,
          recovered: true
        })
      }
      expect(pending(f)).toEqual([])
      await f.restart()
      expect(pending(f)).toEqual([])
      await turn(f, 'probe')
      const state = f.journal.queuedMessages.inputState()
      const measured = isolateJournalTransition(state, (draft) => {
        const row = journalStopEventRowBuilder(
          () => draft,
          { reason: 'user-stop' },
          0
        )(draft.lastSequence + 1, 9999)
        applyJournalRow(draft, row)
      })
      visits.push(measured.tracked())
      const prepare = vi.spyOn(f.db, 'prepare')
      try {
        await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'probe' }, 0)
        work.push(prepare.mock.calls.length)
      } finally {
        prepare.mockRestore()
      }
      expect(pending(f)).toHaveLength(1)
    } finally {
      await f.dispose()
    }
  }
  expect(work[0]).toBeGreaterThan(0)
  expect(work[1]).toBe(work[0])
  expect(visits[1]).toBeLessThanOrEqual(visits[0]! + 20)
})

it('removing the closed turn retires its durable obligation', async () => {
  const f = await fixture()
  try {
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'A' }, 0)
    await turn(f, 'B')
    await f.journal.appendStopEvent({ reason: 'user-close', turnId: 'B' }, 0)
    await f.journal.appendTombstone(identity('B'), { fence: 0 })
    await f.restart()
    expect(pending(f)).toEqual([])
  } finally {
    await f.dispose()
  }
})

it('epoch replacement retains unresolved close when its running target survives', async () => {
  const f = await fixture()
  try {
    await turn(f, 'A')
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'A' }, 0)
    await turn(f, 'B')
    await f.journal.appendStopEvent({ reason: 'user-close', turnId: 'B' }, 0)
    const items = f.journal.snapshot().items.map((i) => ({
      identity: i.body.kind === 'turn' ? identity(i.body.turnId) : identity('unused'),
      body: i.body,
      turnScope: i.turnScope,
      ownerFence: 0
    }))
    await f.journal.replaceEpochItems('handle_forked', 0, items)
    await f.restart()
    await turn(f, 'B', 'interrupted')
    expect(terminal(f, 'B')).toMatchObject({ outcome: 'cancellation' })
  } finally {
    await f.dispose()
  }
})

for (const boundary of ['outcome', 'coverage', 'commit']) {
  it(`failed close at ${boundary} leaves no live or saved authority`, async () => {
    const f = await fixture()
    try {
      await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'A' }, 0)
      await turn(f, 'B')
      const cursor = f.journal.cursor()
      let undo = () => {}
      if (boundary === 'commit') {
        const exec = f.db.exec.bind(f.db)
        const spy = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
          if (sql === 'COMMIT') {
            throw new Error('injected boundary failure')
          }
          exec(sql)
        })
        undo = () => spy.mockRestore()
      } else {
        f.db.exec(
          boundary === 'outcome'
            ? "CREATE TRIGGER failure BEFORE INSERT ON journal_outcomes BEGIN SELECT RAISE(ABORT, 'injected boundary failure'); END"
            : "CREATE TRIGGER failure BEFORE UPDATE ON journal_outcome_epochs BEGIN SELECT RAISE(ABORT, 'injected boundary failure'); END"
        )
        undo = () => f.db.exec('DROP TRIGGER failure')
      }
      try {
        await expect(
          f.journal.appendStopEvent({ reason: 'user-close', turnId: 'B' }, 0)
        ).rejects.toThrow('injected boundary failure')
      } finally {
        undo()
      }
      expect(f.journal.cursor()).toEqual(cursor)
      expect(f.journal.stopMarks.personStopDecides('B')).toBe(false)
      expect(personStopDecidesTurn(restoreJournal(f.db, f.sessionId)!.state, 'B')).toBe(false)
      await turn(f, 'B', 'interrupted')
      expect(terminal(f, 'B')).not.toHaveProperty('outcome')
    } finally {
      await f.dispose()
    }
  })
}

import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-stale-state-settlement'
it('real restart settlement honors the saved named close as proof its target was still live', async () => {
  let clock = 1000
  const f = await fixture(() => ++clock)
  try {
    await turn(f, 'A')
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'A' }, 0)
    await turn(f, 'B')
    await f.journal.appendStopEvent({ reason: 'user-close', turnId: 'B' }, 0)
    await f.restart()
    expect(f.journal.stopMarks.personStopDecides('B')).toBe(true)
    await settleStaleStructuredAgentSessionState({
      journal: f.journal,
      sessionId: f.sessionId,
      fence: 0,
      acquisitionGeneration: null,
      deathEvidence: null,
      replaced: { fence: 0, lastProvenAliveAt: 1000 }
    })
    const body = terminal(f, 'B')
    expect(body).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  } finally {
    await f.dispose()
  }
})

it('a recovery receipt cannot assign an unopened send to the replacement execution', async () => {
  const f = await fixture()
  try {
    await f.journal.appendSubmission({
      clientMessageId: 'delayed',
      payloadFingerprint: 'x',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'report' }] },
      fence: 0,
      handoverRecorded: true
    })
    await f.journal.resolveDispatch({
      clientMessageId: 'delayed',
      state: 'pending',
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    await f.journal.resolveDispatch({
      clientMessageId: 'delayed',
      state: 'unknown',
      fence: 2,
      recovered: true
    })
    await f.restart()
    await f.journal.appendStopEvent({ reason: 'user-close' }, 2)
    expect(pending(f)).toEqual([])
    const restored = restoreJournal(f.db, f.sessionId)!.state
    expect(restored.derivedTurnScope.cancellations.capture(1)).toMatchObject([
      { clientMessageId: 'delayed', ownerFence: 1 }
    ])
  } finally {
    await f.dispose()
  }
})

it('legacy input replay and outcome restore keep both unresolved personal targets', () => {
  const rows: JournalRow[] = [projectionEpochRow]
  for (const [id, reason] of [
    ['A', 'user-stop'],
    ['B', 'user-close']
  ] as const) {
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'item',
      itemId: agentJournalItemKey(identity(id)),
      revision: 1,
      body: { kind: 'turn', turnId: id, state: 'running' },
      turnScope: { kind: 'thread' }
    })
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'tombstone',
      itemId: 'stop-event',
      revision: 1,
      stopEvent: { reason, turnId: id, at: 1000 + rows.length + 1 }
    })
  }
  const fold = startJournalRowFold({ sessionId: 'legacy', epoch: projectionEpochRow.epoch })
  for (const row of rows) {
    fold.add({ seq: row.seq, rowJson: serializeJournalRow(row) })
  }
  const { state, newer, damage } = fold.finish()
  expect({ newer, damage }).toEqual({ newer: null, damage: null })
  expect(activeCancellations(state).map((entry) => entry.target?.turnId)).toEqual(['A', 'B'])
  const b = activeCancellations(state)[1]!
  state.queuePauseMarks.pendingCancellations = [{ sequence: b.sequence, event: b.event }]
  normalizeStopCancellations(state)
  expect(
    activeCancellations(state)
      .map((entry) => entry.target?.turnId)
      .sort()
  ).toEqual(['A', 'B'])
})
