import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../store-lifecycle/journal-host-database-test-support'
import { seedTestJournalHistoricalRows } from './journal-historical-inputs.test-support'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { decodeJournalOutcome } from '../outcomes/journal-outcome-codec'
import {
  AgentSessionJournalError,
  JournalOutcomeDecodeError
} from '../writing/journal-write-guards'
import { withTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'

const journals = createTrackedJournalOpener()
let root: string
const identity = {
  sessionId: 'pause-restore',
  workspaceId: 'ws',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}
const row = (seq: number) => ({ v: 4, epoch: 'historical', seq, fence: 0, ts: 1_000 })
const rows: JournalRow[] = [
  {
    ...row(1),
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread' }
  },
  {
    ...row(2),
    kind: 'queue',
    messageId: 'W',
    change: {
      op: 'queued',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'waiting' }] },
      position: 1,
      queuedAt: null
    }
  },
  {
    ...row(3),
    kind: 'tombstone',
    itemId: 'orca:stop',
    revision: 1,
    stopEvent: { reason: 'user-stop', turnId: 'original', at: 1_000 }
  }
]
const source = () => openTestJournalHostDatabase(root).db
const open = () => journals.open({ identity, stateDirectory: root, now: () => 1_000 })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pause-restore-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
  'preserves the personal Stop through conversion, a distinct close and reopen (retained=%s)',
  async (retained) => {
    seedTestJournalHistoricalRows(source(), identity, rows, retained)
    if (retained) {
      source()
        .prepare(
          "UPDATE journal_outcomes SET value_json=json_remove(value_json,'$.manualStop') WHERE field='$' AND entry_key=?"
        )
        .run(JSON.stringify('queuePauseMarks'))
    }
    let journal = await open()
    const stopped = await journal.queuedMessages.userStopInForce()
    expect(stopped).toMatchObject({ event: { reason: 'user-stop', turnId: 'original' } })
    const before = journal.cursor()
    await withTestAgentSessionDatabase(root, (db) =>
      db.exec(
        `CREATE TRIGGER refuse_pause BEFORE UPDATE OF queue_latest_stop_json ON journal_chat_state BEGIN SELECT RAISE(ABORT, 'pause refused'); END`
      )
    )
    await expect(
      journal.appendStopEvent({ reason: 'user-close', turnId: 'mail' }, 0)
    ).rejects.toThrow('pause refused')
    expect(journal.cursor()).toEqual(before)
    expect(await journal.stopMarks.latest()).toEqual(stopped)
    await withTestAgentSessionDatabase(root, (db) => db.exec('DROP TRIGGER refuse_pause'))
    await journal.appendStopEvent({ reason: 'user-close', turnId: 'mail' }, 0)
    await journal.close()
    journal = await open()
    expect(await journal.stopMarks.latest()).toMatchObject({
      event: { reason: 'user-close', turnId: 'mail' }
    })
    expect(await journal.queuedMessages.userStopInForce()).toEqual(stopped)
    expect(await journal.queuedMessages.nextInputCard()).toBeNull()
    await journal.appendQueueResume(0)
    expect((await journal.queuedMessages.nextInputCard())?.messageId).toBe('W')
  }
)

it('honors an explicit null personal Stop from the frozen outcome format', async () => {
  seedTestJournalHistoricalRows(source(), identity, rows, true)
  source()
    .prepare(
      "UPDATE journal_outcomes SET value_json=json_set(value_json,'$.manualStop',NULL) WHERE field='$' AND entry_key=?"
    )
    .run(JSON.stringify('queuePauseMarks'))
  const journal = await open()
  expect(await journal.queuedMessages.userStopInForce()).toBeNull()
  await journal.appendStopEvent({ reason: 'host-stop' }, 0)
  expect(await journal.queuedMessages.userStopInForce()).toBeNull()
})

it('refuses unknown pause members as newer and damaged declared members as corrupt', () => {
  seedTestJournalHistoricalRows(source(), identity, rows, true)
  const stored = source()
    .prepare(
      "SELECT seq,field,entry_key,format,ordinal,value_json,deleted FROM journal_outcomes WHERE field='$' AND entry_key=? ORDER BY seq DESC LIMIT 1"
    )
    .get(JSON.stringify('queuePauseMarks'))!
  const saved = JSON.parse(String(stored.value_json))
  expect(() =>
    decodeJournalOutcome({
      ...stored,
      value_json: JSON.stringify({ ...saved, manualStop: { ...saved.manualStop, future: true } })
    })
  ).toThrow(AgentSessionJournalError)
  expect(() =>
    decodeJournalOutcome({
      ...stored,
      value_json: JSON.stringify({
        ...saved,
        manualStop: { ...saved.manualStop, sequence: 'broken' }
      })
    })
  ).toThrow(JournalOutcomeDecodeError)
})
