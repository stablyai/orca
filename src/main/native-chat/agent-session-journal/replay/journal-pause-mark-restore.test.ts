import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../store-lifecycle/journal-host-database-test-support'
import { finishTestJournalHistoricalInputs } from './journal-historical-inputs.test-support'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { restoreJournal } from './journal-open'
import { journalOutcomeSource } from '../outcomes/journal-outcome-format'
import { decodeJournalOutcome } from '../outcomes/journal-outcome-codec'
import {
  AgentSessionJournalError,
  JournalOutcomeDecodeError
} from '../writing/journal-write-guards'

const current = createTrackedJournalOpener()
const historical = createTrackedJournalOpener({ legacyInputs: true })
let root: string
const identity = {
  sessionId: 'pause-restore',
  workspaceId: 'ws',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
} as const
const options = () => ({ identity, stateDirectory: root, now: () => 1_000 })
const message: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'waiting' }]
}
const db = () => openTestJournalHostDatabase(root).db
const marks = () => {
  const restored = restoreJournal(db(), identity.sessionId)
  expect(restored?.damage).toBeNull()
  expect(restored?.newer).toBeNull()
  return restored!.state.queuePauseMarks
}
afterEach(async () => {
  await current.closeAll()
  await historical.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('restores separate pause and cancellation owners from complete format-3 scalars and logical replacement', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pause-restore-'))
  let journal = await current.open(options())
  await journal.queuedMessages.insert({ messageId: 'W', body: message, unattended: false })
  await journal.appendStopEvent({ reason: 'user-stop', turnId: 'original' }, 0)
  const stop = {
    sequence: journal.cursor().sequence,
    event: { reason: 'user-stop', turnId: 'original', at: 1_000 }
  }
  await journal.appendStopEvent({ reason: 'user-close', turnId: 'mail' }, 0)
  const close = {
    sequence: journal.cursor().sequence,
    event: { reason: 'user-close', turnId: 'mail', at: 1_000 }
  }
  expect(journalOutcomeSource(db(), identity.sessionId, journal.epoch)?.prefix).toBe(0)
  expect(marks()).toMatchObject({ manualStop: stop, latestStop: close })
  await journal.close()
  journal = await current.open(options())
  expect(journal.stopMarks.latest()).toMatchObject(close)
  expect(journal.queuedMessages.userStopInForce()).toEqual(stop)
  expect(journal.queuedMessages.nextInputCard()).toBeNull()
  await journal.replaceEpochItems('handle_forked', 0, [])
  await journal.close()
  journal = await current.open(options())
  expect(marks()).toMatchObject({ manualStop: stop, latestStop: close })
  expect(journal.queuedMessages.nextInputCard()).toBeNull()
  await journal.appendQueueResume(0)
  expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('W')
})

it.each(['raw-prefix', 'old-format-3-layout'] as const)(
  'adopts the surviving Stop before a replacing write from %s, only on commit',
  async (layout) => {
    root = await mkdtemp(join(tmpdir(), 'orca-pause-adopt-'))
    let journal = await (layout === 'raw-prefix' ? historical : current).open(options())
    await journal.queuedMessages.insert({ messageId: 'W', body: message })
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'original' }, 0)
    const stop = journal.stopMarks.latest()
    await journal.close()
    if (layout === 'old-format-3-layout') {
      db()
        .prepare(
          "UPDATE journal_outcomes SET value_json = json_remove(value_json, '$.manualStop') WHERE field = '$' AND entry_key = ?"
        )
        .run(JSON.stringify('queuePauseMarks'))
    }
    journal = await current.open(options())
    expect(marks().manualStop).toBeUndefined()
    const before = journal.cursor()
    db().exec(`CREATE TEMP TRIGGER refuse_pause BEFORE INSERT ON main.journal_outcomes
      WHEN NEW.field = '$' AND NEW.entry_key = '"queuePauseMarks"'
      BEGIN SELECT RAISE(ABORT, 'pause refused'); END`)
    await expect(
      journal.appendStopEvent({ reason: 'user-close', turnId: 'mail' }, 0)
    ).rejects.toThrow()
    expect(journal.cursor()).toEqual(before)
    expect(journal.stopMarks.latest()).toEqual(stop)
    expect(marks().manualStop).toBeUndefined()
    expect(marks().latestStop).toEqual(stop)
    db().exec('DROP TRIGGER refuse_pause')
    await journal.appendStopEvent({ reason: 'user-close', turnId: 'mail' }, 0)
    await journal.close()
    journal = await current.open(options())
    expect(marks()).toMatchObject({
      manualStop: stop,
      latestStop: { event: { reason: 'user-close', turnId: 'mail' } }
    })
    expect(journal.queuedMessages.userStopInForce()).toEqual(stop)
    expect(journal.queuedMessages.nextInputCard()).toBeNull()
  }
)

it('does not revive a superseded historical Stop, and distinguishes explicit null from an absent mark', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pause-historical-'))
  let journal = await historical.open(options())
  await journal.appendStopEvent({ reason: 'user-stop' }, 0)
  await journal.appendStopEvent({ reason: 'host-stop' }, 0)
  finishTestJournalHistoricalInputs(journal)
  await journal.appendQueueResume(0)
  expect(marks().manualStop).toBeNull()
  await journal.appendStopEvent({ reason: 'user-stop' }, 0)
  await journal.close()
  db()
    .prepare(
      "UPDATE journal_outcomes SET value_json = json_set(value_json, '$.manualStop', NULL) WHERE field = '$' AND entry_key = ?"
    )
    .run(JSON.stringify('queuePauseMarks'))
  journal = await current.open(options())
  expect(journal.queuedMessages.userStopInForce()).toBeNull()
  await journal.appendStopEvent({ reason: 'host-stop' }, 0)
  expect(marks().manualStop).toBeNull()
})

it('refuses unknown pause members as newer and damaged declared members as corrupt', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pause-strict-'))
  const journal = await current.open(options())
  await journal.appendStopEvent({ reason: 'user-stop' }, 0)
  const row = db()
    .prepare(
      "SELECT seq,field,entry_key,format,ordinal,value_json,deleted FROM journal_outcomes WHERE field = '$' AND entry_key = ? ORDER BY seq DESC LIMIT 1"
    )
    .get(JSON.stringify('queuePauseMarks'))!
  const saved = JSON.parse(String(row.value_json))
  expect(() =>
    decodeJournalOutcome({
      ...row,
      value_json: JSON.stringify({ ...saved, manualStop: { ...saved.manualStop, future: true } })
    })
  ).toThrow(AgentSessionJournalError)
  expect(() =>
    decodeJournalOutcome({
      ...row,
      value_json: JSON.stringify({
        ...saved,
        manualStop: { ...saved.manualStop, sequence: 'broken' }
      })
    })
  ).toThrow(JournalOutcomeDecodeError)
})
