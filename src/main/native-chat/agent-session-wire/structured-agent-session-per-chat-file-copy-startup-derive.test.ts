// The background copy as the host builds it waits for #24233's startup status pass (the fold of the
// listed chats with no status row, after paint): it starts no chat while the pass runs.

import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import type * as PerSessionImport from '../agent-session-journal/journal-per-session-import'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import type * as StatusBackfill from '../agent-session-journal/journal-session-status-backfill'
import { foldJournalSessionStatus } from '../agent-session-journal/journal-session-status-backfill'
import {
  createChats,
  createCopyTestRig,
  moveToPerChatFiles,
  perChatFilesLeft,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'

vi.mock('../agent-session-journal/journal-per-session-import', async (importOriginal) => {
  const actual = await importOriginal<typeof PerSessionImport>()
  return { ...actual, importPerSessionJournal: vi.fn(actual.importPerSessionJournal) }
})

vi.mock('../agent-session-journal/journal-session-status-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusBackfill>()
  return { ...actual, foldJournalSessionStatus: vi.fn(actual.foldJournalSessionStatus) }
})

const rigs: CopyTestRig[] = []

afterEach(async () => {
  vi.mocked(importPerSessionJournal).mockReset()
  vi.mocked(foldJournalSessionStatus).mockReset()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

describe('the startup status pass (GATE-4)', () => {
  it('holds the copy the host starts, listed or unlisted, until the pass ends', async () => {
    const rig = await createCopyTestRig()
    rigs.push(rig)
    // A listed chat the pass folds (no status row), and an unlisted one in its old file.
    await createChats(rig, ['session-listed'])
    await createChats(rig, ['session-unlisted'], { listed: false })
    await rig.crash()
    openTestJournalHostDatabase(rig.root)
      .db.prepare("DELETE FROM journal_session_state WHERE session_id = 'session-listed'")
      .run()
    moveToPerChatFiles(rig, ['session-unlisted'])
    await rig.boot()
    const listed = rig.store.getVisibleSessionTabIndex().sessionIds
    await rig.host.reconcileRestartLeases()
    const background = rig.host.seedStoredStatuses(listed)
    expect(background).toEqual(['session-listed'])
    await rig.host.settleOwedSessions(listed)
    // The pass's fold of the listed chat waits until the test lets it finish.
    const pass = Promise.withResolvers<void>()
    const fold = vi.mocked(foldJournalSessionStatus).getMockImplementation()!
    vi.mocked(foldJournalSessionStatus).mockImplementationOnce(async (...args) => {
      await pass.promise
      return fold(...args)
    })
    vi.mocked(importPerSessionJournal).mockClear()

    const restoring = rig.host.restoreReadableSessions(background)
    rig.host.startPerChatFileCopy({ listedIds: listed, isRuntimeChatWorkActive: () => false })
    rig.clock.now += 11_000
    // Several of the copy's ticks.
    await sleep(2_500)

    expect(foldJournalSessionStatus).toHaveBeenCalledOnce()
    expect(importPerSessionJournal).not.toHaveBeenCalled()
    expect(await perChatFilesLeft(rig)).toBe(1)

    pass.resolve()
    await restoring
    await vi.waitFor(async () => expect(await perChatFilesLeft(rig)).toBe(0), {
      timeout: 15_000,
      interval: 100
    })
    expect(readTestJournalSessionStatus(rig.root, 'session-listed')).not.toBeNull()
  }, 30_000)
})
