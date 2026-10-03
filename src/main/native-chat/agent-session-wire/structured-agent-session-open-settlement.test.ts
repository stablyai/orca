// A chat's stored status and its settlement plan are two readings of one set of rules: startup
// selects a chat exactly when its settle would write something, the settle writes exactly the plan,
// and once the plan commits the status reads settled, so nothing is selected twice. Death evidence
// changes only which verdict a running turn gets, never whether the chat is selected.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemBody,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import { isUnsettledJournalSessionStatus } from '../agent-session-journal/journal-session-state'
import {
  CORPUS_DEATH_EVIDENCE,
  CORPUS_FENCE,
  CORPUS_UNSETTLED,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS
} from '../agent-session-journal/journal-session-state-test-corpus'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  appendOpenSettlement,
  planOpenSettlement,
  type OpenSettlementPlan,
  type OpenSettlementRecordFacts
} from './structured-agent-session-open-settlement'

function openSettlementPlanIsEmpty(plan: OpenSettlementPlan): boolean {
  return (
    plan.recoveredDispatches.length === 0 &&
    plan.leftoverQueued.length === 0 &&
    (plan.goneGeneration?.mutations.length ?? 0) === 0 &&
    plan.rosters.length === 0
  )
}

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000
let chats = 0

function open(sessionId: string): Promise<AgentSessionJournal> {
  const identity: AgentSessionJournalIdentity = {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  }
  return journals.open({
    identity,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}`
  })
}

function storedStatus(sessionId: string) {
  const row = readTestJournalSessionStatus(root, sessionId)
  if (!row) {
    throw new Error(`no stored status for ${sessionId}`)
  }
  return row
}

const selected = (sessionId: string) => isUnsettledJournalSessionStatus(storedStatus(sessionId))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-open-settlement-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const COMBINATIONS = JOURNAL_SESSION_STATE_CASES.flatMap((name) =>
  Object.keys(CORPUS_DEATH_EVIDENCE).map((evidence) => [name, evidence] as const)
)

describe('the stored status and the plan agree (T4)', () => {
  it.each(COMBINATIONS)('%s, death evidence %s', async (name, evidenceName) => {
    const sessionId = `chat-${(chats += 1)}`
    const journal = await open(sessionId)
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    const deathEvidence = CORPUS_DEATH_EVIDENCE[evidenceName] ?? null
    const record: OpenSettlementRecordFacts = { sessionId, fence: CORPUS_FENCE, deathEvidence }

    // Pinned per case, so agreement between the status and the plan cannot hide both being wrong.
    expect(selected(sessionId)).toBe(CORPUS_UNSETTLED[name])
    const plan = planOpenSettlement(journal, record, { settlesRosters: true })
    // Evidence naming an `unverifiable` turn's writer lets an open revise it; startup never selects
    // a chat for that (main's acquisition path does it when the chat is next used).
    const revisesVerdictOnly =
      name === 'unverifiable turn' && deathEvidence?.ownerFence === CORPUS_FENCE
    expect(selected(sessionId)).toBe(!openSettlementPlanIsEmpty(plan) && !revisesVerdictOnly)

    // The open appends exactly the plan: a row per roster, per recovered send and per rejected
    // leftover, and one lifecycle batch for what the gone generation left.
    const before = liveTestJournalRows(openTestJournalHostDatabase(root).db, sessionId).length
    await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
      throw error
    })
    const appended =
      liveTestJournalRows(openTestJournalHostDatabase(root).db, sessionId).length - before
    expect(appended).toBe(
      plan.rosters.length +
        plan.recoveredDispatches.length +
        plan.leftoverQueued.length +
        ((plan.goneGeneration?.mutations.length ?? 0) > 0 ? 1 : 0)
    )

    // Every entry revised its entity out of the state that selected it (T4b, T15b).
    expect(selected(sessionId)).toBe(false)
    expect(
      openSettlementPlanIsEmpty(planOpenSettlement(journal, record, { settlesRosters: true }))
    ).toBe(true)
  })

  it("ends a turn a person's Stop found as theirs, with no row saying the provider stopped", async () => {
    const providerStoppedRows = (plan: ReturnType<typeof planOpenSettlement>) =>
      (plan.goneGeneration?.mutations ?? []).filter(
        (mutation) =>
          mutation.kind === 'item' &&
          mutation.identity.provider === 'orca' &&
          mutation.identity.clientMessageId.includes(':death-')
      )
    const settle = async (evidenceName: string) => {
      const sessionId = `chat-${(chats += 1)}`
      const journal = await open(sessionId)
      await JOURNAL_SESSION_STATE_CORPUS["running turn a person's Stop found"](journal)
      const deathEvidence = CORPUS_DEATH_EVIDENCE[evidenceName] ?? null
      const record: OpenSettlementRecordFacts = { sessionId, fence: CORPUS_FENCE, deathEvidence }
      const plan = planOpenSettlement(journal, record, { settlesRosters: true })
      await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
        throw error
      })
      return { sessionId, journal, plan }
    }

    // The process was found dead after the Stop: the Stop decides how the turn ends.
    const after = await settle('names the writer, after a Stop')
    expect(providerStoppedRows(after.plan)).toEqual([])
    expect(after.plan.goneGeneration?.mutations).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'turn', state: 'interrupted' })
      })
    )
    expect(selected(after.sessionId)).toBe(false)
    expect(storedStatus(after.sessionId).summary).toEqual(
      after.journal.statusState(undefined).summary
    )

    // Found dead before the Stop event's time: the death explains the end, and says so.
    const before = await settle('names the writer')
    expect(providerStoppedRows(before.plan)).toHaveLength(1)
  })

  it('agrees on a chat that opened corrupt, and again once it writes past the repair', async () => {
    const first = await open('corrupt')
    await JOURNAL_SESSION_STATE_CORPUS['working subagent roster'](first)
    const tip = first.cursor()
    await first.close()
    insertTestJournalRowJson(openTestJournalHostDatabase(root).db, 'corrupt', tip.sequence + 1, '{')
    const journal = await open('corrupt')
    const record: OpenSettlementRecordFacts = {
      sessionId: 'corrupt',
      fence: CORPUS_FENCE,
      deathEvidence: null
    }
    const plan = () =>
      planOpenSettlement(journal, record, { settlesRosters: !journal.needsRebuild })

    // The rebuild is still owed, so neither touches the roster.
    expect(journal.needsRebuild).toBe(true)
    expect(selected('corrupt')).toBe(false)
    expect(openSettlementPlanIsEmpty(plan())).toBe(true)

    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'note-1' },
      { kind: 'status', text: 'a note' },
      { fence: CORPUS_FENCE, turnScope: { kind: 'thread' } }
    )
    expect(selected('corrupt')).toBe(true)
    expect(plan().rosters).toHaveLength(1)
    await appendOpenSettlement(journal, plan(), CORPUS_FENCE, (error) => {
      throw error
    })
    expect(selected('corrupt')).toBe(false)
  })

  it('selects nothing for an item whose key will not parse, which no plan can revise (R1J-4)', async () => {
    const first = await open('unkeyed')
    await JOURNAL_SESSION_STATE_CORPUS.settled(first)
    const tip = first.cursor()
    await first.close()
    const unkeyed = (seq: number, itemId: string, body: AgentJournalItemBody) =>
      insertTestJournalRow(openTestJournalHostDatabase(root).db, 'unkeyed', {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        kind: 'item',
        itemId,
        revision: 1,
        body,
        epoch: tip.epoch,
        seq,
        fence: CORPUS_FENCE,
        ts: 5_000
      })
    unkeyed(tip.sequence + 1, 'legacy-tool-1', {
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'ls' },
      state: 'running'
    })
    unkeyed(tip.sequence + 2, 'legacy-turn-2', {
      kind: 'turn',
      turnId: 't2',
      state: 'running',
      startedAt: 40
    })
    unkeyed(tip.sequence + 3, 'legacy-turn-3', {
      kind: 'turn',
      turnId: 't3',
      state: 'unverifiable',
      startedAt: 50
    })
    // Written beside the journal, as before the status table: the open writes the status back.
    openTestJournalHostDatabase(root)
      .db.prepare('DELETE FROM journal_session_state WHERE session_id = ?')
      .run('unkeyed')
    const journal = await open('unkeyed')
    // As the chat's open does after its settle.
    journal.backfillSessionStatus()
    expect(readTestJournalSessionStatus(root, 'unkeyed')).not.toBeNull()
    const deathEvidence = CORPUS_DEATH_EVIDENCE['names the writer'] ?? null
    const plan = planOpenSettlement(
      journal,
      { sessionId: 'unkeyed', fence: CORPUS_FENCE, deathEvidence },
      { settlesRosters: true }
    )

    expect(openSettlementPlanIsEmpty(plan)).toBe(true)
    expect(storedStatus('unkeyed')).toMatchObject({ lifecycle: 'idle' })
    expect(selected('unkeyed')).toBe(false)
  })

  it('never selects a chat to revise a verdict: an unverifiable turn stays as it settled (D16 gone)', async () => {
    const journal = await open('unverifiable')
    await JOURNAL_SESSION_STATE_CORPUS['unverifiable turn'](journal)
    expect(storedStatus('unverifiable')).toMatchObject({ lifecycle: 'idle' })
    expect(selected('unverifiable')).toBe(false)
  })

  it('selects a chat whose only debt is a queued leftover, and settles it (T15b)', async () => {
    const journal = await open('queued')
    await JOURNAL_SESSION_STATE_CORPUS['queued leftover'](journal)
    expect(storedStatus('queued')).toMatchObject({ lifecycle: 'idle', queuedSends: 1 })
    const plan = planOpenSettlement(journal, null, { settlesRosters: true })
    expect(plan.leftoverQueued).toEqual(['send-queued'])

    await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
      throw error
    })

    expect(journal.submission('send-queued')).toMatchObject({ dispatchState: 'rejected' })
    expect(storedStatus('queued')).toMatchObject({ queuedSends: 0, summary: { status: 'idle' } })
  })
})
