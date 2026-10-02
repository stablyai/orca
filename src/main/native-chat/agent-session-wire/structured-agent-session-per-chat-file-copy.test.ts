// The background copy of old per-chat files: one run paced at its share, a gate re-derived before
// every run and every chat, listed chats first, a disk guard, a give-up keyed to the file, a failure that
// is logged and never thrown, and an end.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import Database from '../../sqlite/sync-database'
import { NO_LEGACY_JOURNAL_RECORDS } from '../agent-session-journal/journal-database'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import { writePerChatJournalFile } from '../agent-session-journal/journal-per-chat-file-test-support'
import { readJournalSessionEpoch, readJournalTip } from '../agent-session-journal/journal-row-table'
import type * as PerSessionSource from '../agent-session-journal/journal-per-session-source'
import { statPerChatFile } from '../agent-session-journal/journal-per-session-source'
import {
  legacyJournalDatabaseFile,
  perChatJournalRoot
} from '../agent-session-journal/journal-paths'
import {
  importPerSessionJournal,
  type PerSessionJournalImport
} from '../agent-session-journal/journal-per-session-import'
import {
  PER_CHAT_FILE_COPY_DISK_RETRY_MS,
  PER_CHAT_FILE_COPY_INTERVAL_MS,
  StructuredAgentSessionPerChatFileCopy
} from './structured-agent-session-per-chat-file-copy'
import { startStructuredAgentSessionPerChatFileCopy } from './structured-agent-session-per-chat-file-copy-control'
import {
  PER_CHAT_FILE_COPY_BURST_MS,
  PER_CHAT_FILE_COPY_SHARE,
  StructuredAgentSessionPerChatFileCopyPace
} from './structured-agent-session-per-chat-file-copy-pace'
import { restTestChat } from './structured-agent-session-rest-test-rig'
import {
  COPY_TEST_WORKSPACE,
  copyJob,
  copyJobDeps as rigCopyJobDeps,
  createChats,
  createCopyTestRig,
  hasPerChatFile,
  moveToPerChatFiles,
  runToEnd,
  writeStubPerChatFile,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'

vi.mock('../agent-session-journal/journal-per-session-source', async (importOriginal) => {
  const actual = await importOriginal<typeof PerSessionSource>()
  return { ...actual, statPerChatFile: vi.fn(actual.statPerChatFile) }
})

const rigs: CopyTestRig[] = []
const scratch: string[] = []

/** Answers `stat` for the chat whose old-file directory ends in its id, the real stat otherwise. */
async function statChatAs(
  rig: CopyTestRig,
  sessionId: string,
  stat: (directory: string) => ReturnType<typeof statPerChatFile>
): Promise<void> {
  const actual = await vi.importActual<typeof PerSessionSource>(
    '../agent-session-journal/journal-per-session-source'
  )
  const target = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
    sessionId,
    workspaceId: COPY_TEST_WORKSPACE
  })
  vi.mocked(statPerChatFile).mockImplementation((directory) =>
    directory === target ? stat(directory) : actual.statPerChatFile(directory)
  )
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(statPerChatFile).mockReset()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function newRig(): Promise<CopyTestRig> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  return rig
}

const ids = (count: number, prefix = 'session') =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`)

/** Records for `count` chats, each with a stub per-chat file only a fake importer reads. */
async function stubChats(rig: CopyTestRig, count: number, listed = false): Promise<string[]> {
  const sessionIds = ids(count)
  await createChats(rig, sessionIds, { listed, message: false })
  for (const sessionId of sessionIds) {
    writeStubPerChatFile(rig, sessionId)
  }
  return sessionIds
}

/** A fake importer that costs `costMs` of the job's clock per chat. */
function costlyImport(rig: CopyTestRig, costMs: number) {
  return vi.fn(async (_input: Parameters<typeof importPerSessionJournal>[0]) => {
    rig.copyClock.now += costMs
    return { outcome: 'imported' as const }
  })
}

/** The real importer, counted. */
function countedImport() {
  return vi.fn((input: Parameters<typeof importPerSessionJournal>[0]) =>
    importPerSessionJournal(input)
  )
}

describe('one run, paced (T2, R4P-3)', () => {
  it('goes on until the end, its pace alone setting the rate between chats', async () => {
    const rig = await newRig()
    await stubChats(rig, 12)
    const starts: number[] = []
    const slow = vi.fn(async (_input: Parameters<typeof importPerSessionJournal>[0]) => {
      starts.push(rig.copyClock.now)
      rig.copyClock.now += 60
      return { outcome: 'imported' as const }
    })
    const job = copyJob(rig, { importJournal: slow })

    await job.tick()

    // No per-run budget or chat cap: every chat in one run.
    expect(slow).toHaveBeenCalledTimes(12)
    // The pace waited between chats (the fake import never yields), so no second holds more than
    // the share, the burst and one chat.
    const busiest = Math.max(
      ...starts.map((from) => starts.filter((at) => at >= from && at < from + 1_000).length * 60)
    )
    expect(busiest).toBeLessThanOrEqual(
      PER_CHAT_FILE_COPY_BURST_MS + PER_CHAT_FILE_COPY_SHARE * 1_000 + 60
    )
  })

  it('charges none of the idle time between runs', async () => {
    const rig = await newRig()
    await stubChats(rig, 2)
    let listing = false
    const fake = vi.fn(async () => {
      rig.copyClock.now += 60
      // A listing starts with the first chat: the run ends after it.
      listing = true
      return { outcome: 'imported' as const }
    })
    const job = copyJob(rig, { importJournal: fake, isStartupChatWorkActive: () => listing })
    await job.tick()
    expect(fake).toHaveBeenCalledOnce()

    rig.copyClock.now += 10_000
    listing = false
    const resumed = rig.copyClock.now
    await job.tick()

    expect(fake).toHaveBeenCalledTimes(2)
    // Ten idle seconds charged as work would make the pace wait about a minute.
    expect(rig.copyClock.now - resumed).toBeLessThan(1_000)
  })

  it('skips a tick while a run is still going, and ticks a second apart', async () => {
    const rig = await newRig()
    await stubChats(rig, 3)
    const release = Promise.withResolvers<void>()
    const held = vi.fn(async () => {
      await release.promise
      return { outcome: 'imported' as const }
    })
    const job = copyJob(rig, { importJournal: held })

    const first = job.tick()
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
    await job.tick()
    release.resolve()
    await first
    expect(held).toHaveBeenCalledTimes(3)

    const interval = vi.spyOn(globalThis, 'setInterval')
    job.start()
    expect(interval).toHaveBeenCalledWith(expect.any(Function), PER_CHAT_FILE_COPY_INTERVAL_MS)
    await job.stop()
  })
})

describe('waiting for startup chat work (T16)', () => {
  it('runs nothing in the first 10 s, and runs then when nothing else is in flight', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    const fake = costlyImport(rig, 1)
    const job = copyJob(rig, { importJournal: fake, startDelayMs: undefined })

    rig.copyClock.now = 9_999
    await job.tick()
    expect(fake).not.toHaveBeenCalled()
    // An orcad-style host no client has listed yet: nothing gates it once the floor passes.
    rig.copyClock.now = 10_000
    await job.tick()
    expect(fake).toHaveBeenCalledOnce()
  })

  it('starts no run while startup chat work is in flight', async () => {
    const rig = await newRig()
    await stubChats(rig, 2)
    const fake = costlyImport(rig, 1)
    let active = true
    const job = copyJob(rig, { importJournal: fake, isStartupChatWorkActive: () => active })

    await job.tick()
    expect(fake).not.toHaveBeenCalled()
    active = false
    await job.tick()
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('pauses after the chat in hand when a listing starts mid-run', async () => {
    const rig = await newRig()
    await stubChats(rig, 5)
    let listing = false
    const fake = vi.fn(async () => {
      // A late client lists its tabs while this chat copies.
      listing = true
      return { outcome: 'imported' as const }
    })
    const job = copyJob(rig, { importJournal: fake, isStartupChatWorkActive: () => listing })

    await job.tick()
    expect(fake).toHaveBeenCalledOnce()
    listing = false
    await job.tick()
    expect(fake).toHaveBeenCalledTimes(2)
  })
})

describe('the copy’s share of the main thread (C3)', () => {
  it('runs every copy and missing row inside the chat, handing on that chat’s paced yield', async () => {
    const rig = await newRig()
    await stubChats(rig, 2, true)
    // A missing row long enough that its fold takes more than one task.
    await restTestChat(rig, 'session-rowless', { listed: false, message: 'x'.repeat(600_000) })
    await rig.crash()
    openTestJournalHostDatabase(rig.root)
      .db.prepare("DELETE FROM journal_session_state WHERE session_id = 'session-rowless'")
      .run()
    await rig.boot()
    const deps = rigCopyJobDeps(rig)
    const pace = deps.pace!
    const handed = new Map<string, () => Promise<void>>()
    const yields = new Map<string, number>()
    const inChat = pace.inChat.bind(pace)
    vi.spyOn(pace, 'inChat').mockImplementation((lock, sessionId, task) =>
      inChat(lock, sessionId, (yieldTask) => {
        const counted = () => {
          yields.set(sessionId, (yields.get(sessionId) ?? 0) + 1)
          return yieldTask()
        }
        handed.set(sessionId, counted)
        return task(counted)
      })
    )
    const fake = costlyImport(rig, 1)

    await runToEnd(rig, new StructuredAgentSessionPerChatFileCopy({ ...deps, importJournal: fake }))

    for (const [input] of fake.mock.calls) {
      expect(input.yieldTask).toBe(handed.get(input.identity.sessionId))
    }
    expect(yields.get('session-rowless')).toBeGreaterThan(0)
  })

  it('ends the wait of its pace at quit', async () => {
    const rig = await newRig()
    const pace = new StructuredAgentSessionPerChatFileCopyPace()
    const stop = vi.spyOn(pace, 'stop')

    await copyJob(rig, { pace }).stop()

    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('order (T15)', () => {
  it('copies listed chats first, in tab order, then the rest', async () => {
    const rig = await newRig()
    const unlisted = await stubChats(rig, 3)
    await createChats(rig, ['listed-b', 'listed-a'], { message: false })
    for (const sessionId of ['listed-b', 'listed-a']) {
      writeStubPerChatFile(rig, sessionId)
    }
    const fake = costlyImport(rig, 1)
    const job = copyJob(rig, { importJournal: fake })

    await runToEnd(rig, job)

    const order = fake.mock.calls.map(([input]) => input.identity.sessionId)
    expect(order.slice(0, 2)).toEqual(['listed-b', 'listed-a'])
    expect(order.slice(2).toSorted()).toEqual(unlisted)
  })
})

describe('the disk guard (T12)', () => {
  it('starts no chat below the free-space floor, probes again only after 60 s, then copies', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    const fake = costlyImport(rig, 1)
    let free = 100 * 1024 * 1024
    const freeBytes = vi.fn(async () => free)
    const job = copyJob(rig, { importJournal: fake, freeBytes })

    await job.tick()
    expect(fake).not.toHaveBeenCalled()
    expect(freeBytes).toHaveBeenCalledOnce()
    rig.copyClock.now += 1_000
    await job.tick()
    expect(freeBytes).toHaveBeenCalledOnce()

    free = 8 * 1024 * 1024 * 1024
    rig.copyClock.now += PER_CHAT_FILE_COPY_DISK_RETRY_MS
    await job.tick()
    expect(fake).toHaveBeenCalledOnce()
  })

  it('leaves a chat too big for the free space owed, and copies the rest in the same run', async () => {
    const rig = await newRig()
    const [big, small] = await stubChats(rig, 2, true)
    // 200 MiB: four times that is more than the 600 MiB free, which is above the 512 MiB floor.
    await statChatAs(rig, big, () => ({
      dbSize: 200 * 1024 * 1024,
      dbMtimeMs: 1,
      walSize: null,
      walMtimeMs: null
    }))
    const fake = costlyImport(rig, 1)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const job = copyJob(rig, { importJournal: fake, freeBytes: async () => 600 * 1024 * 1024 })

    await job.tick()

    expect(fake.mock.calls.map(([input]) => input.identity.sessionId)).toEqual([small])
    await runToEnd(rig, job)
    expect(fake).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ noRoom: 1 }))
    expect(hasPerChatFile(rig, big)).toBe(true)
  })
})

describe('a failure is logged, never thrown (S1)', () => {
  it('skips a chat whose file cannot even be read, and copies the rest', async () => {
    const rig = await newRig()
    const [first, unreadable, last] = await stubChats(rig, 3, true)
    await statChatAs(rig, unreadable, () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = costlyImport(rig, 1)

    await runToEnd(rig, copyJob(rig, { importJournal: fake }))

    expect(fake.mock.calls.map(([input]) => input.identity.sessionId)).toEqual([first, last])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('copying an old chat file failed'),
      expect.objectContaining({ sessionId: unreadable })
    )
  })

  it('ends the job for this launch when a run fails outside any one chat', async () => {
    const rig = await newRig()
    await stubChats(rig, 1, true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = costlyImport(rig, 1)
    const store = {
      getRecord: () => {
        throw new Error('records unreadable')
      },
      listRecords: () => rig.store.listRecords()
    }
    const job = copyJob(rig, { importJournal: fake, store })
    const clear = vi.spyOn(globalThis, 'clearInterval')
    job.start()

    await expect(job.tick()).resolves.toBeUndefined()

    expect(job.isFinished).toBe(true)
    expect(clear).toHaveBeenCalled()
    expect(fake).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stopped for this launch'),
      expect.objectContaining({ error: expect.any(Error) })
    )
  })

  it('ends the missing-row phase, logged, when the chats it owes cannot be read', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-rowless'], { listed: false })
    await rig.crash()
    openTestJournalHostDatabase(rig.root).db.prepare('DELETE FROM journal_session_state').run()
    await rig.boot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const store = {
      getRecord: () => {
        throw new Error('records unreadable')
      },
      listRecords: () => rig.store.listRecords()
    }

    await runToEnd(rig, copyJob(rig, { listedIds: [], store }))

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reading chats without a status failed'),
      expect.objectContaining({ error: expect.any(Error) })
    )
    // It ended as a job that finished, not one a failure stopped.
    expect(info).toHaveBeenCalledWith(expect.stringContaining('old chat files copied'), {})
  })
})

describe('what the job never touches (T13, T14, T18)', () => {
  it('never opens or deletes a file no chat record names, nor an older build’s recovery copy', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-real'])
    await rig.crash()
    moveToPerChatFiles(rig, ['session-real'])
    const database = openTestJournalHostDatabase(rig.root)
    const orphan = writePerChatJournalFile(
      database.legacyDirectoryFor({ sessionId: 'deleted-chat', workspaceId: COPY_TEST_WORKSPACE }),
      'deleted-chat',
      { epoch: 'orphan', rows: [] }
    )
    const recovered = writePerChatJournalFile(
      `${database.legacyDirectoryFor({ sessionId: 'session-real', workspaceId: COPY_TEST_WORKSPACE })}-recovered-v3`,
      'session-real',
      { epoch: 'recovered', rows: [] }
    )
    const counted = countedImport()

    await runToEnd(rig, copyJob(rig, { importJournal: counted }))

    expect(counted.mock.calls.map(([input]) => input.identity.sessionId)).toEqual(['session-real'])
    expect(existsSync(orphan)).toBe(true)
    expect(existsSync(recovered)).toBe(true)
    expect(hasPerChatFile(rig, 'session-real')).toBe(false)
  })

  it('never starts while the records file is still owed, or on a newer build’s database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-copy-start-'))
    scratch.push(directory)
    await mkdir(perChatJournalRoot(directory), { recursive: true })
    const deps = (database: JournalHostDatabase) => ({
      ...copyJobDeps,
      database
    })

    const owed = JournalHostDatabase.openWith(directory, { owed: true })
    expect(owed.legacyRecordImportOwed).toBe(true)
    expect(startStructuredAgentSessionPerChatFileCopy(deps(owed))).toBeNull()
    owed.close()

    const newer = new Database(join(directory, 'agent-session-journal.db'))
    newer.pragma('user_version = 99')
    newer.close()
    const readOnly = JournalHostDatabase.openWith(directory, NO_LEGACY_JOURNAL_RECORDS)
    expect(readOnly.readOnly).toBe(true)
    expect(startStructuredAgentSessionPerChatFileCopy(deps(readOnly))).toBeNull()
    readOnly.close()
  })

  it('never calls the importer for a set-aside file, and still ends', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    openTestJournalHostDatabase(rig.root)
      .db.prepare('INSERT INTO journal_set_aside (session_id, epoch, tip) VALUES (?, ?, ?)')
      .run('session-0', 'stub', 0)
    const counted = countedImport()
    const job = copyJob(rig, { importJournal: counted })

    await runToEnd(rig, job)

    expect(counted).not.toHaveBeenCalled()
    expect(hasPerChatFile(rig, 'session-0')).toBe(true)
  })
})

/** A job's dependencies that `startStructuredAgentSessionPerChatFileCopy` never reaches when it
 *  refuses to start. */
const copyJobDeps = {
  store: { getRecord: () => null, listRecords: () => [] },
  listedIds: [],
  isStartupChatWorkActive: () => false,
  chatWork: { sendInFlight: () => false, onActivity: () => () => undefined },
  serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
  openJournal: () => undefined,
  settleClosedChat: async () => false,
  canSettle: (record: AgentSessionRecord | null): record is AgentSessionRecord => record !== null,
  isDisposed: () => false,
  logger: createStructuredAgentSessionLogger(),
  now: () => 0,
  appVersion: '1.0.0'
}

describe('a copy that fails (T10, T11)', () => {
  it('records a file that will not open, skips it while it stays the same, and tries a changed one once', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-broken'], { message: false })
    const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
      sessionId: 'session-broken',
      workspaceId: COPY_TEST_WORKSPACE
    })
    await mkdir(directory, { recursive: true })
    const file = legacyJournalDatabaseFile(directory)
    await writeFile(file, 'not a database '.repeat(512))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const counted = countedImport()

    await runToEnd(rig, copyJob(rig, { importJournal: counted }))
    expect(counted).toHaveBeenCalledOnce()
    expect(
      openTestJournalHostDatabase(rig.root)
        .db.prepare(
          'SELECT step, input, app_version FROM journal_background_failures WHERE session_id = ?'
        )
        .get('session-broken')
    ).toEqual({
      step: 'copy',
      input: expect.stringMatching(new RegExp(`^${'not a database '.repeat(512).length}:`)),
      app_version: '1.0.0'
    })

    // The next launch, same file and version: not tried.
    await runToEnd(rig, copyJob(rig, { importJournal: counted }))
    expect(counted).toHaveBeenCalledOnce()
    // A new version tries it once more.
    await runToEnd(rig, copyJob(rig, { importJournal: counted, appVersion: '1.0.1' }))
    expect(counted).toHaveBeenCalledTimes(2)
    // So does a file that moved since.
    await utimes(file, new Date(), new Date(Date.now() + 60_000))
    await runToEnd(rig, copyJob(rig, { importJournal: counted, appVersion: '1.0.1' }))
    expect(counted).toHaveBeenCalledTimes(3)
    expect(existsSync(file)).toBe(true)
  })

  it('tries a transient failure at most three times a launch, records nothing, and keeps the file', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const full = vi.fn(async (): Promise<PerSessionJournalImport> => {
      throw Object.assign(new Error('database or disk is full'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 13
      })
    })

    await runToEnd(rig, copyJob(rig, { importJournal: full }))

    expect(full).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledOnce()
    expect(
      openTestJournalHostDatabase(rig.root)
        .db.prepare('SELECT count(*) AS n FROM journal_background_failures')
        .get()
    ).toEqual({ n: 0 })
    expect(hasPerChatFile(rig, 'session-0')).toBe(true)
  })
})

describe('the end (T17)', () => {
  it('stops its timer, removes the emptied directories, and the next launch starts nothing', async () => {
    const rig = await newRig()
    const sessionIds = ids(3)
    await createChats(rig, sessionIds)
    await rig.crash()
    moveToPerChatFiles(rig, sessionIds)
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const job = copyJob(rig)
    job.start()

    await runToEnd(rig, job)

    expect(clear).toHaveBeenCalled()
    expect(existsSync(perChatJournalRoot(rig.root))).toBe(false)
    expect(
      startStructuredAgentSessionPerChatFileCopy({
        ...copyJobDeps,
        database: openTestJournalHostDatabase(rig.root)
      })
    ).toBeNull()
  })
})

describe('the missing-row phase (L2, A8)', () => {
  /** Chats in the host's database, closed, with no status row, as after the version 5 migration. */
  async function chatsWithoutRows(rig: CopyTestRig, sessionIds: readonly string[]): Promise<void> {
    await createChats(rig, sessionIds, { listed: false })
    await rig.crash()
    openTestJournalHostDatabase(rig.root).db.prepare('DELETE FROM journal_session_state').run()
    await rig.boot()
  }

  const startJob = (rig: CopyTestRig, appVersion = '1.0.0') =>
    startStructuredAgentSessionPerChatFileCopy({
      ...copyJobDeps,
      store: rig.store,
      database: openTestJournalHostDatabase(rig.root),
      appVersion
    })

  it('writes no row for a chat whose record is gone, and starts no job for one', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-kept'], { listed: false })
    openTestJournalHostDatabase(rig.root)
      .db.prepare('INSERT INTO journal_sessions (session_id, workspace_id, epoch) VALUES (?, ?, ?)')
      .run('session-gone', COPY_TEST_WORKSPACE, 'epoch-gone')
    // Only the record-less chat has no row.
    expect(startJob(rig)).toBeNull()

    await chatsWithoutRows(rig, [])
    await runToEnd(rig, copyJob(rig))

    expect(readTestJournalSessionStatus(rig.root, 'session-kept')).not.toBeNull()
    expect(readTestJournalSessionStatus(rig.root, 'session-gone')).toBeNull()
    expect(startJob(rig)).toBeNull()
  })

  it('gives up on a row that fails for good until the chat or the app version changes', async () => {
    const rig = await newRig()
    await chatsWithoutRows(rig, ['session-bad'])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = vi.fn(async (): Promise<never> => {
      throw new Error('malformed row')
    })

    await runToEnd(rig, copyJob(rig, { serialize: failing }))

    expect(failing).toHaveBeenCalledOnce()
    // The next launch: the same rows under the same version owe nothing.
    expect(startJob(rig)).toBeNull()
    const updated = startJob(rig, '1.0.1')
    expect(updated).not.toBeNull()
    await updated?.stop()
    // A chat written to since is owed again.
    const { db } = openTestJournalHostDatabase(rig.root)
    const epoch = readJournalSessionEpoch(db, 'session-bad')!
    db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    ).run('session-bad', epoch, readJournalTip(db, 'session-bad', epoch) + 1, 1, '{}')
    const written = startJob(rig)
    expect(written).not.toBeNull()
    await written?.stop()
  })

  it('records nothing for a failure a later try may clear', async () => {
    const rig = await newRig()
    await chatsWithoutRows(rig, ['session-busy'])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const locked = vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
    })

    await runToEnd(rig, copyJob(rig, { serialize: locked }))

    const job = startJob(rig)
    expect(job).not.toBeNull()
    await job?.stop()
  })
})
