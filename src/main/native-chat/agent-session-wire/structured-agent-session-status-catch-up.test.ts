// The first launch after the upgrade to stored status: listed chats with history and no status row
// get their rows from their rows alone before the tab listing answers, with no conversation opened.
// The seed then publishes them and the settle takes any a crash left with work, in the same launch.

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as JournalSessionStateModule from '../agent-session-journal/journal-session-state'
import { JOURNAL_SESSION_STATUS_RULES } from '../agent-session-journal/journal-session-state'
import type * as StatusBackfillModule from '../agent-session-journal/journal-session-status-backfill'
import type * as JournalRecoveryModule from './agent-session-journal-recovery'
import type * as PerSessionImportModule from '../agent-session-journal/journal-per-session-import'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRowJson,
  liveTestJournalRows,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import {
  createRestTestRig,
  restTestChat,
  sendRestTestMessage,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { StructuredAgentSessionStartupGate } from '../../runtime/structured-agent-session-startup-gate'
import {
  latestRestTestStatus,
  restTestOpens
} from './structured-agent-session-rest-test-observations'
import { moveRestTestChatToPerChatFile } from './structured-agent-session-rest-test-per-chat-file'

// The listed chats' stored-status read fails once, when set: the catch-up's own read.
const reads = vi.hoisted(() => {
  const control: { failNext: boolean } = { failNext: false }
  return control
})

vi.mock('../agent-session-journal/journal-session-state', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalSessionStateModule>()
  return {
    ...actual,
    readJournalSessionStatuses: (...args: Parameters<typeof actual.readJournalSessionStatuses>) => {
      if (reads.failNext) {
        reads.failNext = false
        throw new Error('database is locked')
      }
      return actual.readJournalSessionStatuses(...args)
    }
  }
})

// The catch-up's work as it happens: fold parts, finished folds and batch commits.
const work = vi.hoisted(() => {
  const seen: {
    parts: number
    folded: string[]
    commits: number
    /** Runs as each fold ends, before its batch is written. */
    afterFold: ((sessionId: string) => Promise<void>) | null
  } = { parts: 0, folded: [], commits: 0, afterFold: null }
  return seen
})

vi.mock('../agent-session-journal/journal-session-status-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusBackfillModule>()
  return {
    ...actual,
    foldJournalSessionStatus: async (
      ...[database, sessionId, options]: Parameters<typeof actual.foldJournalSessionStatus>
    ) => {
      const yieldTask = options?.yieldTask
      const folded = await actual.foldJournalSessionStatus(database, sessionId, {
        ...options,
        yieldTask: async () => {
          work.parts += 1
          await yieldTask?.()
        }
      })
      work.parts += 1
      work.folded.push(sessionId)
      await work.afterFold?.(sessionId)
      return folded
    },
    writeJournalSessionStatuses: (
      ...args: Parameters<typeof actual.writeJournalSessionStatuses>
    ) => {
      work.commits += 1
      return actual.writeJournalSessionStatuses(...args)
    }
  }
})

// Each chat an open found corrupt and sent through its rebuild.
const rebuilds = vi.hoisted(() => {
  const opened: { sessionIds: string[] } = { sessionIds: [] }
  return opened
})

vi.mock('./agent-session-journal-recovery', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalRecoveryModule>()
  return {
    ...actual,
    openAgentSessionJournalWithRecovery: async (
      ...args: Parameters<typeof actual.openAgentSessionJournalWithRecovery>
    ) => {
      const opened = await actual.openAgentSessionJournalWithRecovery(...args)
      if (opened.recovery?.trigger === 'journal_corrupt') {
        rebuilds.sessionIds.push(args[0].identity.sessionId)
      }
      return opened
    }
  }
})

// Each preview of a chat still in its per-chat file, and the chats whose file reads as damaged.
const previews = vi.hoisted(() => {
  const seen: { sessionIds: string[]; damaged: Set<string> } = {
    sessionIds: [],
    damaged: new Set()
  }
  return seen
})

vi.mock('../agent-session-journal/journal-per-session-import', async (importOriginal) => {
  const actual = await importOriginal<typeof PerSessionImportModule>()
  return {
    ...actual,
    previewPerSessionJournal: async (
      ...args: Parameters<typeof actual.previewPerSessionJournal>
    ) => {
      const { sessionId } = args[0].identity
      previews.sessionIds.push(sessionId)
      if (previews.damaged.has(sessionId)) {
        throw new Error('file is not a database')
      }
      return actual.previewPerSessionJournal(...args)
    }
  }
})

const rigs: RestTestRig[] = []

afterEach(async () => {
  reads.failNext = false
  work.parts = 0
  work.folded.length = 0
  work.commits = 0
  work.afterFold = null
  rebuilds.sessionIds.length = 0
  previews.sessionIds.length = 0
  previews.damaged.clear()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

async function newRig(): Promise<RestTestRig> {
  const rig = await createRestTestRig()
  rigs.push(rig)
  return rig
}

/** Every chat's row dropped, as version 5 finds a database an older build wrote. */
function upgradeToEmptyStatusTable(rig: RestTestRig): void {
  openTestJournalHostDatabase(rig.root).db.prepare('DELETE FROM journal_session_state').run()
}

const listedIds = (rig: RestTestRig) => rig.store.getVisibleSessionTabIndex().sessionIds

/** Startup as the host's step runs it, through the settle; answers the restore's list. */
async function startup(rig: RestTestRig): Promise<string[]> {
  const listed = listedIds(rig)
  await rig.host.reconcileRestartLeases()
  await rig.host.catchUpMissingStatuses(listed)
  await rig.host.restoreListedFromPerChatFiles(listed)
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  return background
}

/** A chat whose turn was still running when Orca died, with or without a tab. */
async function crashMidTurn(rig: RestTestRig, sessionId: string, listed = true): Promise<void> {
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
  const { providerIdentity } = await rig.adapter.dispatch.mock.results.at(-1)!.value
  await rig.host
    .collaboratorsForTests()
    .sessions.get(sessionId)!
    .journal.appendItem(
      { ...providerIdentity, ordinal: 0 },
      { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
      { fence: rig.store.getRecord(sessionId)!.lease.runtimeFence, turnScope: { kind: 'thread' } }
    )
}

const firstStatus = (rig: RestTestRig, sessionId: string) =>
  rig.statusEvents.findIndex(
    (event) => event.type === 'status' && event.session.sessionId === sessionId
  )

/** The status stream's length when each chat first opened. */
function recordOpens(rig: RestTestRig): Map<string, number> {
  const openedAt = new Map<string, number>()
  rig.adapter.historyFilePath.mockImplementation(async (sessionId) => {
    if (!openedAt.has(sessionId)) {
      openedAt.set(sessionId, rig.statusEvents.length)
    }
    return null
  })
  return openedAt
}

describe('listed chats with no stored status after the upgrade', () => {
  it('get their rows before the seed, from their rows alone, with no chat opened', async () => {
    const rig = await newRig()
    const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()

    const background = await startup(rig)

    expect(background).toEqual([])
    for (const sessionId of ids) {
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toMatchObject({ lifecycle: 'idle' })
      expect(latestRestTestStatus(rig, sessionId)).toMatchObject({ status: 'idle' })
      expect(restTestOpens(rig, sessionId)).toBe(0)
    }
    // Published by the seed, in the listing's order.
    const order = ids.map((sessionId) => firstStatus(rig, sessionId))
    expect(order).toEqual(order.toSorted((a, b) => a - b))
  })

  it('settles an unfinished one in the same launch, before commands go, never showing it from its rows', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-fine', { message: 'done' })
    await crashMidTurn(rig, 'session-running')
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const listed = listedIds(rig)
    const openedAt = recordOpens(rig)
    await rig.host.reconcileRestartLeases()

    await rig.host.catchUpMissingStatuses(listed)
    // Stored, so the settle selects it; not shown: the seed leaves an unsettled row to the settle.
    expect(readTestJournalSessionStatus(rig.root, 'session-running')).toMatchObject({
      lifecycle: 'running'
    })
    rig.host.seedStoredStatuses(listed)
    expect(latestRestTestStatus(rig, 'session-running')).toBeUndefined()
    // The settle is what chat commands wait on.
    await rig.host.settleOwedSessions(listed)

    expect(restTestOpens(rig, 'session-fine')).toBe(0)
    expect(openedAt.has('session-running')).toBe(true)
    expect(firstStatus(rig, 'session-running')).toBeGreaterThanOrEqual(
      openedAt.get('session-running')!
    )
    expect(readTestJournalSessionStatus(rig.root, 'session-running')).toMatchObject({
      lifecycle: 'idle'
    })
    expect(latestRestTestStatus(rig, 'session-running')?.status).not.toBe('working')
  })

  it('leaves an unlisted crashed chat with no row showing nothing until its open settles it', async () => {
    const rig = await newRig()
    await crashMidTurn(rig, 'session-closed', false)
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    expect(listedIds(rig)).not.toContain('session-closed')

    await startup(rig)

    expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toBeNull()
    expect(latestRestTestStatus(rig, 'session-closed')).toBeUndefined()
    expect(restTestOpens(rig, 'session-closed')).toBe(0)

    // The first read opens it, and the open settles it.
    await rig.host.history({ sessionId: 'session-closed', direction: 'tail' })
    expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toMatchObject({
      lifecycle: 'idle'
    })
    expect(latestRestTestStatus(rig, 'session-closed')?.status).not.toBe('working')
  })

  it('appends few WAL pages for 247 chats: their rows are written 16 to a transaction', async () => {
    const rig = await newRig()
    const ids = Array.from({ length: 247 }, (_, index) => `session-page-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const { db } = openTestJournalHostDatabase(rig.root)
    // An empty WAL, so its size after the catch-up is what the catch-up appended.
    db.pragma('wal_checkpoint(TRUNCATE)')
    const pageSize = Number(db.pragma('page_size', { simple: true }))

    await rig.host.catchUpMissingStatuses(listedIds(rig))

    const frames =
      (statSync(join(rig.root, 'agent-session-journal.db-wal')).size - 32) / (pageSize + 24)
    expect(ids.every((sessionId) => readTestJournalSessionStatus(rig.root, sessionId))).toBe(true)
    expect(ids.every((sessionId) => restTestOpens(rig, sessionId) === 0)).toBe(true)
    // A commit per chat appends about 2.5 pages each, over 600 for these.
    expect(frames).toBeLessThanOrEqual(150)
  }, 120_000)

  it('gives a corrupt one no row, so the restore after the listing opens it and its rebuild runs', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-corrupt', { message: 'asked' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    const { db } = openTestJournalHostDatabase(rig.root)
    const tip = liveTestJournalRows(db, 'session-corrupt').at(-1)!
    insertTestJournalRowJson(db, 'session-corrupt', tip.seq + 1, '{')
    upgradeToEmptyStatusTable(rig)
    expect(loadTestJournal(rig.root, 'session-corrupt')).toMatchObject({ corrupt: true })
    await rig.boot()

    const background = await startup(rig)

    expect(readTestJournalSessionStatus(rig.root, 'session-corrupt')).toBeNull()
    expect(latestRestTestStatus(rig, 'session-corrupt')).toBeUndefined()
    expect(background).toEqual(['session-corrupt'])
    await rig.host.restoreReadableSessions(background)
    expect(rebuilds.sessionIds).toEqual(['session-corrupt'])
  })

  it('derives a row again on the next launch when its unsynced commit was lost', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-settled', { message: 'asked session-settled' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    await startup(rig)
    const first = readTestJournalSessionStatus(rig.root, 'session-settled')
    const firstPublished = latestRestTestStatus(rig, 'session-settled')
    expect(first).toMatchObject({ lifecycle: 'idle' })

    // A power cut loses the unsynced commit: the next launch finds no row.
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const before = rig.statusEvents.length
    await startup(rig)

    expect(readTestJournalSessionStatus(rig.root, 'session-settled')).toEqual(first)
    expect(latestRestTestStatus(rig, 'session-settled')).toEqual(firstPublished)
    expect(
      rig.statusEvents
        .slice(before)
        .every((event) => event.type !== 'status' || event.session.sessionId === 'session-settled')
    ).toBe(true)
    expect(restTestOpens(rig, 'session-settled')).toBe(0)
  })

  it('lets the seed, the settle and the rest go on when the catch-up fails', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-rowed', { message: 'asked session-rowed' })
    await restTestChat(rig, 'session-rowless', { message: 'asked session-rowless' })
    await crashMidTurn(rig, 'session-crashed')
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    openTestJournalHostDatabase(rig.root)
      .db.prepare('DELETE FROM journal_session_state WHERE session_id = ?')
      .run('session-rowless')
    await rig.boot()
    const warn = vi.spyOn(rig.host.deps.logger, 'warn')
    reads.failNext = true

    const background = await startup(rig)

    expect(warn).toHaveBeenCalledWith(
      'deriving missing chat statuses at startup failed',
      expect.objectContaining({ scope: 'startup-status-catch-up' })
    )
    // The seed read the rows itself, the rowless chat went to the restore, the settle ran.
    expect(latestRestTestStatus(rig, 'session-rowed')).toMatchObject({ status: 'idle' })
    expect(background).toEqual(['session-rowless'])
    expect(readTestJournalSessionStatus(rig.root, 'session-crashed')).toMatchObject({
      lifecycle: 'idle'
    })
  })

  it('restores a listed chat still in its per-chat file before the listing answers, read once', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-file', { message: 'asked session-file' })
    await restTestChat(rig, 'session-closed-file', { message: 'asked', listed: false })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    await moveRestTestChatToPerChatFile(rig, 'session-file')
    await moveRestTestChatToPerChatFile(rig, 'session-closed-file')
    await rig.boot()

    const background = await startup(rig)

    // Restored from its file by the time the listing answers: open, settled and published.
    expect(rig.host.hasSession('session-file')).toBe(true)
    expect(latestRestTestStatus(rig, 'session-file')).toMatchObject({
      latestPrompt: 'asked session-file'
    })
    // Not queued for the restore after the listing, which skips it even when given every listed
    // chat (its list when startup gave none): one preview, one open.
    expect(background).toEqual([])
    await rig.host.restoreReadableSessions(listedIds(rig))
    expect(previews.sessionIds.filter((id) => id === 'session-file')).toEqual(['session-file'])
    expect(restTestOpens(rig, 'session-file')).toBe(1)
    // One with no tab waits for its first use.
    expect(rig.host.hasSession('session-closed-file')).toBe(false)
    expect(previews.sessionIds).not.toContain('session-closed-file')
    expect(latestRestTestStatus(rig, 'session-closed-file')).toBeUndefined()
  })

  it('isolates a damaged per-chat file and a missing one: the others restore and startup goes on', async () => {
    const rig = await newRig()
    for (const sessionId of ['session-damaged', 'session-missing', 'session-file']) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    await moveRestTestChatToPerChatFile(rig, 'session-damaged')
    await moveRestTestChatToPerChatFile(rig, 'session-file')
    // Its file is gone too: nothing of it anywhere but its record and tab.
    for (const table of ['journal_rows', 'journal_sessions', 'journal_session_state']) {
      openTestJournalHostDatabase(rig.root)
        .db.prepare(`DELETE FROM ${table} WHERE session_id = ?`)
        .run('session-missing')
    }
    previews.damaged.add('session-damaged')
    await rig.boot()
    const warn = vi.spyOn(rig.host.deps.logger, 'warn')

    const background = await startup(rig)

    expect(listedIds(rig)).toEqual(['session-damaged', 'session-missing', 'session-file'])
    expect(rig.host.hasSession('session-file')).toBe(true)
    expect(latestRestTestStatus(rig, 'session-file')).toMatchObject({ status: 'idle' })
    expect(warn).toHaveBeenCalledWith(
      'restoring a chat for reading failed',
      expect.objectContaining({ sessionId: 'session-damaged' })
    )
    expect(rig.host.hasSession('session-damaged')).toBe(false)
    // The damaged file is tried again after the listing; the chat with no file anywhere has nothing
    // to read, and is listed all the same.
    expect(background).toEqual(['session-damaged'])
  })
  it('gives a chat whose tab closes during the catch-up its row, but no status row', async () => {
    const rig = await newRig()
    for (const sessionId of ['session-kept', 'session-closing']) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    let closedAt = -1
    // A close is not held for startup: it lands between the catch-up's folds.
    work.afterFold = async (sessionId) => {
      if (sessionId === 'session-kept') {
        await rig.host.setSessionTabVisibility('session-closing', false)
        await rig.host.close('session-closing', 'user-close')
        closedAt = rig.statusEvents.length
      }
    }

    await startup(rig)

    expect(closedAt).toBeGreaterThan(-1)
    expect(readTestJournalSessionStatus(rig.root, 'session-closing')).toMatchObject({
      lifecycle: 'idle'
    })
    expect(
      rig.statusEvents
        .slice(closedAt)
        .filter((event) => event.type === 'status' && event.session.sessionId === 'session-closing')
    ).toEqual([])
    expect(restTestOpens(rig, 'session-closing')).toBe(0)
    expect(latestRestTestStatus(rig, 'session-kept')).toMatchObject({ status: 'idle' })
  })

  it('lets a send through mid-catch-up once the gate ceiling passes, behind at most one fold part and one batch commit', async () => {
    const rig = await newRig()
    const ids = Array.from({ length: 6 }, (_, index) => `session-long-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
      const journal = rig.host.collaboratorsForTests().sessions.get(sessionId)!.journal
      const fence = rig.store.getRecord(sessionId)!.lease.runtimeFence
      // Long enough that its fold takes several parts, as a long chat's does.
      for (let index = 0; index < 1_200; index += 1) {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: `${sessionId}-note-${index}` },
          { kind: 'status', text: `${index} ${'x'.repeat(400)}` },
          { fence, turnScope: { kind: 'thread' } }
        )
      }
    }
    await restTestChat(rig, 'session-send', { message: 'first' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    // The chat the send goes to keeps its row; the long ones are the catch-up's.
    openTestJournalHostDatabase(rig.root)
      .db.prepare('DELETE FROM journal_session_state WHERE session_id != ?')
      .run('session-send')
    const gate = new StructuredAgentSessionStartupGate(30)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    gate.hold()
    await rig.boot({ commandsReady: gate.ready })
    // Every task's budget is spent at its first check, so each fold part is a task of its own.
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100))
    let sent: Promise<unknown> | null = null
    let ahead = { parts: -1, commits: -1 }
    // The catch-up's progress when the send was answered.
    let answeredAt = { folded: -1, commits: -1 }
    work.afterFold = async (sessionId) => {
      if (sessionId !== ids[0]) {
        return
      }
      // The catch-up outlasts the gate's ceiling, which lets commands go.
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(gate.ready()).toBeNull()
      const before = { parts: work.parts, commits: work.commits }
      // A send arrives as a message: its own task, which runs once the catch-up yields.
      sent = new Promise((resolve) => {
        setImmediate(() => {
          ahead = { parts: work.parts - before.parts, commits: work.commits - before.commits }
          resolve(
            sendRestTestMessage(rig, 'session-send', 'during the catch-up').then((answer) => {
              answeredAt = { folded: work.folded.length, commits: work.commits }
              return answer
            })
          )
        })
      })
    }

    await rig.host.catchUpMissingStatuses(listedIds(rig))

    expect(await sent).toMatchObject({ ok: true })
    expect(ahead.parts).toBeGreaterThanOrEqual(0)
    expect(ahead.parts).toBeLessThanOrEqual(1)
    expect(ahead.commits).toBeLessThanOrEqual(1)
    // Answered while the catch-up still ran: before its last fold and its last commit.
    expect(answeredAt.folded).toBeGreaterThan(0)
    expect(answeredAt.folded).toBeLessThan(ids.length)
    expect(answeredAt.commits).toBeLessThan(work.commits)
    expect(ids.every((sessionId) => readTestJournalSessionStatus(rig.root, sessionId))).toBe(true)
  }, 120_000)
})

describe('a stored status derived by other rules', () => {
  /** The chat's row as a build with other derivation rules left it. */
  function deriveByOtherRules(rig: RestTestRig, sessionId: string, lifecycle = 'idle'): void {
    openTestJournalHostDatabase(rig.root)
      .db.prepare(
        `UPDATE journal_session_state SET rules_version = ?, lifecycle = ?,
          summary_json = '{"status":"idle","latestPrompt":"by other rules"}' WHERE session_id = ?`
      )
      .run(JOURNAL_SESSION_STATUS_RULES - 1, lifecycle, sessionId)
  }

  const rulesOf = (rig: RestTestRig, sessionId: string) =>
    openTestJournalHostDatabase(rig.root)
      .db.prepare('SELECT rules_version FROM journal_session_state WHERE session_id = ?')
      .get(sessionId)?.rules_version

  it('is derived again for a listed chat exactly as a missing row is, and its old row is never shown', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-kept', { message: 'asked session-kept' })
    await restTestChat(rig, 'session-other-rules', { message: 'asked session-other-rules' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    deriveByOtherRules(rig, 'session-other-rules')
    await rig.boot()

    const background = await startup(rig)

    // The rowless path: one fold, one batched write, no open.
    expect(work.folded).toEqual(['session-other-rules'])
    expect(work.commits).toBe(1)
    expect(restTestOpens(rig, 'session-other-rules')).toBe(0)
    expect(background).toEqual([])
    expect(rulesOf(rig, 'session-other-rules')).toBe(JOURNAL_SESSION_STATUS_RULES)
    expect(latestRestTestStatus(rig, 'session-other-rules')).toMatchObject({
      status: 'idle',
      latestPrompt: 'asked session-other-rules'
    })
  })

  it('is left alone for a chat with no tab until it opens, and never selects it to settle', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-closed', { message: 'asked session-closed', listed: false })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    // By other rules it would be owed: this build does not trust that.
    deriveByOtherRules(rig, 'session-closed', 'running')
    await rig.boot()

    await startup(rig)

    expect(work.folded).toEqual([])
    expect(restTestOpens(rig, 'session-closed')).toBe(0)
    expect(rulesOf(rig, 'session-closed')).toBe(JOURNAL_SESSION_STATUS_RULES - 1)
    expect(latestRestTestStatus(rig, 'session-closed')).toBeUndefined()

    // Its open writes the row by these rules.
    await rig.host.history({ sessionId: 'session-closed', direction: 'tail' })
    expect(rulesOf(rig, 'session-closed')).toBe(JOURNAL_SESSION_STATUS_RULES)
    expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toMatchObject({
      lifecycle: 'idle',
      summary: { latestPrompt: 'asked session-closed' }
    })
  })
})
