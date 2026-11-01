import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

import {
  PROVEN,
  RUNNING_IDENTITY,
  THREAD,
  journalWith,
  lifecycleItem,
  turnScopeOf
} from './structured-agent-session-stale-verdict-contract-test-fixture'

it('revises an unverifiable turn only from a proof naming its own owner, and only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let now = 100
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => now
    })
    await journal.appendItem(
      RUNNING_IDENTITY,
      { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: 100 },
      { fence: 1, turnScope: turnScopeOf(RUNNING_IDENTITY) }
    )
    now = 400
    const settle = (deathEvidence: AgentSessionDeathEvidence | null) =>
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: null,
        deathEvidence
      })
    await settle(null)
    now = 9_000
    const turn = () => journal.snapshot().items.map((item) => readAgentJournalTurn(item.body))[0]
    expect(turn()).toMatchObject({ state: 'unverifiable' })

    const unrevised = journal.cursor()
    await expect(settle({ ...PROVEN, ownerFence: 2 })).resolves.toBe(0)
    const { ownerFence: _ownerFence, ...olderBuildProof } = PROVEN
    await expect(settle({ ...olderBuildProof, kind: 'exit-observed' })).resolves.toBe(0)
    expect(journal.cursor()).toEqual(unrevised)
    expect(turn()).toMatchObject({ state: 'unverifiable' })

    await expect(settle(PROVEN)).resolves.toBe(2)
    expect(turn()).toEqual({
      turnId: 'turn-2',
      state: 'interrupted',
      startedAt: 100,
      completedAt: 100
    })
    const revised = journal.cursor()
    await expect(settle(PROVEN)).resolves.toBe(0)
    expect(journal.cursor()).toEqual(revised)
    expect(journal.snapshot().items.filter((item) => item.body.kind === 'status')).toHaveLength(1)
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('adds one row for a death however many attempts its settle takes to write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let now = 100
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => now
    })
    for (let index = 0; index < 399; index++) {
      const turnId = `turn-${index}`
      await journal.appendItem(
        { ...RUNNING_IDENTITY, turnId },
        { kind: 'turn', turnId, state: 'running', startedAt: 100 },
        { fence: 1, turnScope: turnScopeOf({ ...RUNNING_IDENTITY, turnId }) }
      )
    }
    now = 9_000
    const settle = () =>
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: null,
        deathEvidence: PROVEN
      })
    const turns = () =>
      journal.snapshot().items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
    const statusRows = () => journal.snapshot().items.filter((item) => item.body.kind === 'status')
    const database = openTestJournalHostDatabase(root)
    const cursor = journal.cursor()
    database.db.exec(`CREATE TEMP TRIGGER reject_later_stale_settlement
      BEFORE INSERT ON journal_rows
      WHEN NEW.session_id = 'session-1' AND NEW.seq > ${cursor.sequence + 1}
        AND json_extract(NEW.row_json, '$.recovered') = 1
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)

    await expect(settle()).rejects.toThrow('disk full')
    database.db.exec('DROP TRIGGER reject_later_stale_settlement')
    expect(journal.cursor()).toEqual(cursor)
    expect(turns().filter((turn) => turn.state === 'running')).toHaveLength(399)
    expect(statusRows()).toHaveLength(0)

    await settle()
    expect(turns().filter((turn) => turn.state !== 'interrupted')).toEqual([])
    expect(statusRows()).toHaveLength(1)
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('writes nothing when no turn is running and keys on the journal position without a generation', async () => {
  const idle = journalWith([
    lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 })
  ])
  await expect(
    settleStaleStructuredAgentSessionState({
      journal: idle.journal,
      sessionId: 'session-1',
      fence: 14,
      acquisitionGeneration: null,
      deathEvidence: null
    })
  ).resolves.toBe(0)
  expect(idle.appendLifecycleBatch).not.toHaveBeenCalled()

  const running = journalWith([lifecycleItem('turn-2', 'running', 2)])
  await settleStaleStructuredAgentSessionState({
    journal: running.journal,
    sessionId: 'session-1',
    fence: 14,
    acquisitionGeneration: null,
    deathEvidence: null
  })
  expect(running.appendLifecycleBatch).toHaveBeenCalledWith(
    expect.objectContaining({ settlementId: 'stale-session:session-1:14:seq-8' })
  )
})
