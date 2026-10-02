// A chat whose history is corrupt gets no status row from the background copy, as the startup pass
// leaves one, so its open rebuilds it: a copied one is published without a row, and one already in
// the host's database is folded once, given up on until its rows change, and starts no job.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StatusBackfill from '../agent-session-journal/journal-session-status-backfill'
import { foldJournalSessionStatus } from '../agent-session-journal/journal-session-status-backfill'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRowJson,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import { readJournalSessionEpoch, readJournalTip } from '../agent-session-journal/journal-row-table'
import { startStructuredAgentSessionPerChatFileCopy } from './structured-agent-session-per-chat-file-copy-control'
import {
  copyJob,
  copyJobDeps,
  createChats,
  createCopyTestRig,
  hasPerChatFile,
  moveToPerChatFiles,
  runToEnd,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'

vi.mock('../agent-session-journal/journal-session-status-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusBackfill>()
  return { ...actual, foldJournalSessionStatus: vi.fn(actual.foldJournalSessionStatus) }
})

const rigs: CopyTestRig[] = []

afterEach(async () => {
  vi.mocked(foldJournalSessionStatus).mockClear()
  vi.restoreAllMocks()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

const CORRUPT = 'session-corrupt'

/** The chat, closed, with a row no fold can read after its own. */
async function corruptChat(): Promise<CopyTestRig> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  await createChats(rig, [CORRUPT], { listed: false })
  await rig.crash()
  const { db } = openTestJournalHostDatabase(rig.root)
  const epoch = readJournalSessionEpoch(db, CORRUPT)!
  insertTestJournalRowJson(db, CORRUPT, readJournalTip(db, CORRUPT, epoch) + 1, '{"not a row"')
  return rig
}

const rowsOf = (rig: CopyTestRig) =>
  openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT count(*) AS n FROM journal_rows WHERE session_id = ?')
    .get(CORRUPT)

const giveUps = (rig: CopyTestRig) =>
  openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT step FROM journal_background_failures WHERE session_id = ?')
    .all(CORRUPT)

const folds = () =>
  vi.mocked(foldJournalSessionStatus).mock.calls.filter(([, sessionId]) => sessionId === CORRUPT)
    .length

/** The next launch's job, or null when it owes nothing. */
function nextLaunch(rig: CopyTestRig) {
  return startStructuredAgentSessionPerChatFileCopy(copyJobDeps(rig))
}

describe('a chat whose history is corrupt', () => {
  it('is copied out of its old file with its rows published and no status row', async () => {
    const rig = await corruptChat()
    const rows = rowsOf(rig)
    moveToPerChatFiles(rig, [CORRUPT])
    await rig.boot()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = copyJobDeps(rig)

    await runToEnd(rig, copyJob(rig, deps))

    expect(hasPerChatFile(rig, CORRUPT)).toBe(false)
    expect(rowsOf(rig)).toEqual(rows)
    expect(readTestJournalSessionStatus(rig.root, CORRUPT)).toBeNull()
    expect(deps.settleClosedChat).not.toHaveBeenCalled()
    // Its missing row is then given up on, so the next launch starts nothing for it.
    expect(giveUps(rig)).toEqual([{ step: 'status' }])
    expect(nextLaunch(rig)).toBeNull()
  })

  it('is folded once in the host’s database, gets no row, and starts no job until its rows change', async () => {
    const rig = await corruptChat()
    openTestJournalHostDatabase(rig.root).db.prepare('DELETE FROM journal_session_state').run()
    await rig.boot()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await runToEnd(rig, copyJob(rig))

    expect(folds()).toBe(1)
    expect(readTestJournalSessionStatus(rig.root, CORRUPT)).toBeNull()
    expect(giveUps(rig)).toEqual([{ step: 'status' }])
    // The next launch owes it nothing, and a job run anyway folds it no more.
    expect(nextLaunch(rig)).toBeNull()
    await runToEnd(rig, copyJob(rig))
    expect(folds()).toBe(1)

    // A write to the chat (its open's rebuild does one) makes it owed again.
    const { db } = openTestJournalHostDatabase(rig.root)
    const epoch = readJournalSessionEpoch(db, CORRUPT)!
    insertTestJournalRowJson(db, CORRUPT, readJournalTip(db, CORRUPT, epoch) + 1, '{}')
    const owed = nextLaunch(rig)
    expect(owed).not.toBeNull()
    await owed?.stop()
  })
})
