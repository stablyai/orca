// The background copy as the host builds it (reveal, the copy control, the job), not a job a test
// assembles: a restored chat's own owed import is charged to the copy's pace but runs unpaced, and
// the pace waits only between chats; and a chat that streams on that host holds the copy off, through
// the host's own status feed.

import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import type * as PerSessionImport from '../agent-session-journal/journal-per-session-import'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { StructuredAgentSessionPerChatFileCopy } from './structured-agent-session-per-chat-file-copy'
import { StructuredAgentSessionPerChatFileCopyPace } from './structured-agent-session-per-chat-file-copy-pace'
import { timedJournalImportPages } from '../agent-session-journal/journal-import-page'
import { sendRestTestMessage } from './structured-agent-session-rest-test-rig'
import { PER_CHAT_FILE_COPY_QUIET_MS } from './structured-agent-session-per-chat-file-copy-activity'
import {
  copyJobDeps,
  createChats,
  createCopyTestRig,
  moveToPerChatFiles,
  openLiveChat,
  perChatFilesLeft,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'

vi.mock('../agent-session-journal/journal-per-session-import', async (importOriginal) => {
  const actual = await importOriginal<typeof PerSessionImport>()
  return { ...actual, importPerSessionJournal: vi.fn(actual.importPerSessionJournal) }
})

const rigs: CopyTestRig[] = []

afterEach(async () => {
  vi.mocked(importPerSessionJournal).mockReset()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

/** Each chat's timeline as the host served it before the crash. */
const historyBeforeCrash = new Map<string, unknown>()

/** A listed chat the startup restore opened from its old file, and an unlisted one, both still
 *  in their files. */
async function restoredAndUnlisted(): Promise<CopyTestRig> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  await createChats(rig, ['session-listed'])
  await createChats(rig, ['session-unlisted'], { listed: false })
  for (const sessionId of ['session-listed', 'session-unlisted']) {
    await rig.host.flushStreamedEvents(sessionId)
    historyBeforeCrash.set(sessionId, (await rig.host.journalSnapshot(sessionId)).items)
  }
  await rig.crash()
  moveToPerChatFiles(rig, ['session-listed', 'session-unlisted'])
  await rig.boot()
  const listed = rig.store.getVisibleSessionTabIndex().sessionIds
  await rig.host.reconcileRestartLeases()
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  await rig.host.restoreReadableSessions(background)
  expect(restoredJournal(rig).importPending).toBe(true)
  return rig
}

const restoredJournal = (rig: CopyTestRig) =>
  rig.host.collaboratorsForTests().sessions.get('session-listed')!.journal

describe('a restored chat’s copy (G2, R6)', () => {
  it('is charged to the pace the host starts, which pays it before the next chat', async () => {
    const rig = await restoredAndUnlisted()
    const actual = await vi.importActual<typeof PerSessionImport>(
      '../agent-session-journal/journal-per-session-import'
    )
    const at: Record<string, number> = {}
    const paced: Record<string, boolean> = {}
    vi.mocked(importPerSessionJournal).mockImplementation(async (input) => {
      const { sessionId } = input.identity
      at[`${sessionId}:start`] = performance.now()
      paced[sessionId] = typeof input.yieldTask === 'function'
      // The restored chat's copy takes 400 ms of the main thread's wall time.
      if (sessionId === 'session-listed') {
        await sleep(400)
      }
      const result = await actual.importPerSessionJournal(input)
      at[`${sessionId}:end`] = performance.now()
      return result
    })

    rig.host.startPerChatFileCopy({
      listedIds: rig.store.getVisibleSessionTabIndex().sessionIds,
      isRuntimeChatWorkActive: () => false
    })
    rig.clock.now += 11_000
    await vi.waitFor(async () => expect(await perChatFilesLeft(rig)).toBe(0), {
      timeout: 15_000,
      interval: 100
    })

    // 400 ms charged against a 50 ms burst is a debt worth about two seconds at the share.
    expect(at['session-unlisted:start'] - at['session-listed:end']).toBeGreaterThan(1_000)
    // The owed import, which a reader may be waiting on through the chat's write queue, takes no
    // yield of the copy's; the copy's own import takes its in-chat one.
    expect(paced).toEqual({ 'session-listed': false, 'session-unlisted': true })
    expect(restoredJournal(rig).importPending).toBe(false)
  }, 30_000)

  it('pages by time only the copy’s own work: its imports and the owed import it pays; a user’s send pays it whole', async () => {
    const recorded: unknown[] = []
    const unlisted: unknown[] = []
    vi.mocked(importPerSessionJournal).mockImplementation(async (input) => {
      if (input.identity.sessionId === 'session-listed') {
        recorded.push(input.pages)
      } else if (input.identity.sessionId === 'session-unlisted') {
        unlisted.push(input.pages)
      }
      const actual = await vi.importActual<typeof PerSessionImport>(
        '../agent-session-journal/journal-per-session-import'
      )
      return actual.importPerSessionJournal(input)
    })
    const rig = await restoredAndUnlisted()
    const setUp = recorded.length
    const sent = await sendRestTestMessage(rig, 'session-listed', 'after the restart')
    expect(sent.ok).toBe(true)
    expect(restoredJournal(rig).importPending).toBe(false)
    expect(recorded.slice(setUp)).toEqual([undefined])

    const copied = await restoredAndUnlisted()
    const copySetUp = recorded.length
    const unlistedSetUp = unlisted.length
    await new StructuredAgentSessionPerChatFileCopy(copyJobDeps(copied)).tick()
    expect(restoredJournal(copied).importPending).toBe(false)
    expect(recorded.slice(copySetUp)).toEqual([timedJournalImportPages])
    // The job's own import of a closed chat.
    expect(unlisted.slice(unlistedSetUp)).toEqual([timedJournalImportPages])
  }, 20_000)

  it('waits only between chats, never inside one', async () => {
    const rig = await restoredAndUnlisted()
    let clock = 0
    let insideChat = false
    const waits: boolean[] = []
    // Every task reads as a second of work, so every yield owes a wait.
    const pace = new StructuredAgentSessionPerChatFileCopyPace(
      () => (clock += 1_000),
      async () => {
        waits.push(insideChat)
      }
    )
    const inChat = pace.inChat.bind(pace)
    vi.spyOn(pace, 'inChat').mockImplementation(async (serialize, sessionId, task) =>
      inChat(serialize, sessionId, async (yieldTask) => {
        insideChat = true
        try {
          return await task(yieldTask)
        } finally {
          insideChat = false
        }
      })
    )
    const job = new StructuredAgentSessionPerChatFileCopy({ ...copyJobDeps(rig), pace })

    for (let tick = 0; tick < 20 && !job.isFinished; tick += 1) {
      await job.tick()
    }

    expect(job.isFinished).toBe(true)
    expect(restoredJournal(rig).importPending).toBe(false)
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.filter((inside) => inside)).toEqual([])
  }, 20_000)
})

describe('a chat working on the host the copy runs on (G3)', () => {
  const startCopy = (rig: CopyTestRig) => {
    rig.host.startPerChatFileCopy({
      listedIds: rig.store.getVisibleSessionTabIndex().sessionIds,
      isRuntimeChatWorkActive: () => false
    })
    rig.clock.now += 11_000
  }

  it('holds off the copy the host starts while frames arrive, which goes on once they stop', async () => {
    const rig = await restoredAndUnlisted()
    const live = await openLiveChat(rig, 'session-live')
    await live.streamTurn()
    // Opening the live chat looked for its old file.
    vi.mocked(importPerSessionJournal).mockClear()

    startCopy(rig)
    // A stream's deltas, through several of the copy's ticks.
    const streaming = setInterval(live.frame, 100)
    try {
      await sleep(2_500)
    } finally {
      clearInterval(streaming)
    }
    expect(importPerSessionJournal).not.toHaveBeenCalled()
    expect(await perChatFilesLeft(rig)).toBe(2)

    rig.clock.now += PER_CHAT_FILE_COPY_QUIET_MS
    await vi.waitFor(async () => expect(await perChatFilesLeft(rig)).toBe(0), {
      timeout: 15_000,
      interval: 100
    })
    expect(restoredJournal(rig).importPending).toBe(false)
  }, 30_000)

  it('never starts a chat while the chats never go quiet, and every chat still opens whole', async () => {
    const rig = await restoredAndUnlisted()
    const live = await openLiveChat(rig, 'session-live')
    const deps = copyJobDeps(rig)
    const inChat = vi.spyOn(deps.pace!, 'inChat')
    const job = new StructuredAgentSessionPerChatFileCopy(deps)
    // A turn that streams for the whole test: a frame between every two ticks.
    await live.streamTurn()

    for (let tick = 0; tick < 120; tick += 1) {
      live.frame()
      rig.copyClock.now += 1_000
      await job.tick()
    }

    expect(inChat).not.toHaveBeenCalled()
    expect(await perChatFilesLeft(rig)).toBe(2)
    // The read path a chat not yet copied takes today: the restored chat from its preview, the
    // closed one through its first use's own copy.
    for (const sessionId of ['session-listed', 'session-unlisted']) {
      expect(historyBeforeCrash.get(sessionId)).not.toEqual([])
      expect((await rig.host.journalSnapshot(sessionId)).items, sessionId).toEqual(
        historyBeforeCrash.get(sessionId)
      )
    }
    expect(inChat).not.toHaveBeenCalled()
  }, 30_000)

  it('stops a restored chat’s owed import at its next batch, still owed, when one starts', async () => {
    const rig = await restoredAndUnlisted()
    const live = await openLiveChat(rig, 'session-live')
    const actual = await vi.importActual<typeof PerSessionImport>(
      '../agent-session-journal/journal-per-session-import'
    )
    const ends: string[] = []
    let yieldsAfterWork = 0
    vi.mocked(importPerSessionJournal).mockImplementation(async (input) => {
      let yields = 0
      try {
        const result = await actual.importPerSessionJournal({
          ...input,
          batchRows: 1,
          yieldTask: async () => {
            await (input.yieldTask?.() ?? sleep(0))
            yields += 1
            if (ends.length === 0 && input.identity.sessionId === 'session-listed') {
              if (yields === 2) {
                await live.streamTurn()
              } else if (yields > 2) {
                yieldsAfterWork += 1
              }
            }
          }
        })
        ends.push(`${input.identity.sessionId}:${result.outcome}`)
        return result
      } catch (error) {
        ends.push(`${input.identity.sessionId}:stopped`)
        throw error
      }
    })

    startCopy(rig)
    await vi.waitFor(() => expect(ends).toEqual(['session-listed:stopped']), {
      timeout: 15_000,
      interval: 50
    })
    expect(yieldsAfterWork).toBe(0)
    expect(restoredJournal(rig).importPending).toBe(true)
    await sleep(2_500)
    expect(ends).toEqual(['session-listed:stopped'])

    await live.endTurn()
    rig.clock.now += PER_CHAT_FILE_COPY_QUIET_MS
    await vi.waitFor(async () => expect(await perChatFilesLeft(rig)).toBe(0), {
      timeout: 15_000,
      interval: 100
    })
    expect(ends).toEqual([
      'session-listed:stopped',
      'session-listed:imported',
      'session-unlisted:imported'
    ])
    expect(restoredJournal(rig).importPending).toBe(false)
  }, 30_000)
})
