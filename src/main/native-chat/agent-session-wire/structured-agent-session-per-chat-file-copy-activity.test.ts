// The background copy against chats that work on the same host, through the host's own chat
// activity (provider frames, sends in flight): no chat starts while frames arrive or a send is in
// flight, a chat whose copy is under way stops at its next batch when a frame arrives, and the
// copy goes on once no frame has come for the quiet period, a parked or silent turn included.

import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { legacyJournalDatabaseFile } from '../agent-session-journal/journal-paths'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { openLegacySource } from '../agent-session-journal/journal-per-session-source'
import type * as SessionState from '../agent-session-journal/journal-session-state'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus
} from '../agent-session-journal/journal-session-state'
import {
  PER_CHAT_FILE_COPY_QUIET_MS,
  StructuredAgentSessionPerChatFileCopyActivity
} from './structured-agent-session-per-chat-file-copy-activity'
import {
  COPY_TEST_WORKSPACE,
  copyJob,
  copyJobDeps,
  createChats,
  createCopyTestRig,
  hasPerChatFile,
  moveToPerChatFiles,
  openLiveChat,
  perChatFilesLeft,
  type CopyTestRig,
  type LiveTestChat
} from './structured-agent-session-per-chat-file-copy-test-rig'
import { restTestChat, sendRestTestMessage } from './structured-agent-session-rest-test-rig'
import { StructuredAgentSessionChatActivity } from './structured-agent-session-chat-activity'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'

vi.mock('../agent-session-journal/journal-session-state', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionState>()
  return { ...actual, deriveJournalSessionStatus: vi.fn(actual.deriveJournalSessionStatus) }
})

const rigs: CopyTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

const OLD = ['session-old-0', 'session-old-1']

/** Two chats in their old files, with the status rows they had before, and a chat open on the
 *  host that has not worked yet. */
async function oldChatsAndALiveOne(): Promise<{
  rig: CopyTestRig
  live: LiveTestChat
  statusBefore: Record<string, unknown>
}> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  await createChats(rig, OLD, { listed: false })
  await rig.crash()
  const statusBefore = Object.fromEntries(OLD.map((id) => [id, statusRow(rig, id)]))
  moveToPerChatFiles(rig, OLD)
  await rig.boot()
  const live = await openLiveChat(rig, 'session-live')
  expect(rig.host['clientDelivery'].chatWork.sendInFlight()).toBe(false)
  return { rig, live, statusBefore }
}

const statusRow = (rig: CopyTestRig, sessionId: string) =>
  openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT * FROM journal_session_state WHERE session_id = ?')
    .get(sessionId)

/** The chat's epochs and every row of any epoch, as stored in `db`. */
function storedChat(db: Pick<Database, 'prepare'>, sessionId: string) {
  return {
    epochs: db.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').all(sessionId),
    rows: db
      .prepare(
        'SELECT epoch, seq, ts, row_json FROM journal_rows WHERE session_id = ? ORDER BY epoch, seq'
      )
      .all(sessionId)
  }
}

/** The chat as its old file holds it. */
function storedInFile(rig: CopyTestRig, sessionId: string) {
  const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
    sessionId,
    workspaceId: COPY_TEST_WORKSPACE
  })
  const file = new Database(legacyJournalDatabaseFile(directory), { readonly: true })
  try {
    return storedChat(file, sessionId)
  } finally {
    file.close()
  }
}

/** The real importer, a row per batch so a chat takes several, counted. */
function rowPerBatchImport(onYield: (yields: number) => Promise<void> = async () => undefined) {
  let yields = 0
  return vi.fn((input: Parameters<typeof importPerSessionJournal>[0]) =>
    importPerSessionJournal({
      ...input,
      batchRows: 1,
      yieldTask: async () => {
        await input.yieldTask?.()
        yields += 1
        await onYield(yields)
      }
    })
  )
}

const failuresRecorded = (rig: CopyTestRig) =>
  openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT count(*) AS n FROM journal_background_failures')
    .get()

const rowsOf = (rig: CopyTestRig, sessionId: string) =>
  openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT count(*) AS n FROM journal_rows WHERE session_id = ?')
    .get(sessionId)

const published = (rig: CopyTestRig, sessionId: string) =>
  openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT count(*) AS n FROM journal_sessions WHERE session_id = ?')
    .get(sessionId)

describe('a chat working on the same host (G3)', () => {
  /** The job's ticks, a second of its clock apart, with `each` run before every one. */
  async function tickFor(
    rig: CopyTestRig,
    job: ReturnType<typeof copyJob>,
    seconds: number,
    each: () => unknown = () => undefined
  ): Promise<void> {
    for (let tick = 0; tick < seconds; tick += 1) {
      await each()
      rig.copyClock.now += 1_000
      await job.tick()
    }
  }

  it.each([
    ['streams a turn', (live: LiveTestChat) => live.streamTurn()],
    [
      'is parked on an approval while its turn still sends frames',
      async (live: LiveTestChat) => {
        await live.streamTurn()
        await live.askUnderTurn()
      }
    ]
  ] as const)('starts no chat while a chat that %s', async (_case, work) => {
    const { rig, live } = await oldChatsAndALiveOne()
    const importJournal = rowPerBatchImport()
    const job = copyJob(rig, { importJournal })
    await work(live)

    // Frames a second apart, as a stream's deltas or a subagent's output arrive.
    await tickFor(rig, job, 3 * (PER_CHAT_FILE_COPY_QUIET_MS / 1_000), live.frame)

    expect(importJournal).not.toHaveBeenCalled()
    expect(await perChatFilesLeft(rig)).toBe(OLD.length)
  })

  it('starts no chat while a send is in flight, with no frame at all', async () => {
    const { rig, live } = await oldChatsAndALiveOne()
    const importJournal = rowPerBatchImport()
    const job = copyJob(rig, { importJournal })
    // Long past any frame of its own: only the send holds the copy.
    rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS
    await live.sendUnanswered()
    expect(rig.host['clientDelivery'].chatWork.sendInFlight()).toBe(true)

    await tickFor(rig, job, 3 * (PER_CHAT_FILE_COPY_QUIET_MS / 1_000))

    expect(importJournal).not.toHaveBeenCalled()
    expect(await perChatFilesLeft(rig)).toBe(OLD.length)
  })

  it('holds the copy for a send that starts its chat’s agent, from accept through hand-over', async () => {
    const rig = await createCopyTestRig()
    rigs.push(rig)
    await createChats(rig, [...OLD, 'session-cold'], { listed: false })
    await rig.crash()
    moveToPerChatFiles(rig, OLD)
    await rig.boot()
    const importJournal = rowPerBatchImport()
    const job = copyJob(rig, { importJournal })
    const chatWork = rig.host['clientDelivery'].chatWork
    // The agent's start waits until the test lets it finish.
    const started = Promise.withResolvers<void>()
    const acquire = rig.adapter.acquire.getMockImplementation()!
    rig.adapter.acquire.mockImplementationOnce(async (input) => {
      await started.promise
      return acquire(input)
    })
    const acquires = rig.adapter.acquire.mock.calls.length
    const dispatches = rig.adapter.dispatch.mock.calls.length

    const sending = sendRestTestMessage(rig, 'session-cold', 'wake up')
    await vi.waitFor(() => expect(rig.adapter.acquire.mock.calls.length).toBeGreaterThan(acquires))
    expect(chatWork.sendInFlight()).toBe(true)
    await tickFor(rig, job, 3 * (PER_CHAT_FILE_COPY_QUIET_MS / 1_000))
    expect(importJournal).not.toHaveBeenCalled()

    started.resolve()
    expect((await sending).ok).toBe(true)
    await vi.waitFor(() =>
      expect(rig.adapter.dispatch.mock.calls.length).toBeGreaterThan(dispatches)
    )
    await rig.host.flushStreamedEvents('session-cold')
    // Handed over and answered: no longer in flight.
    expect(chatWork.sendInFlight()).toBe(false)
    await tickFor(rig, job, 1)
    expect(await perChatFilesLeft(rig)).toBe(0)
  })

  it('does not hold the copy for a send queued behind a running agent’s turn', async () => {
    const { rig, live } = await oldChatsAndALiveOne()
    const importJournal = rowPerBatchImport()
    const job = copyJob(rig, { importJournal })
    await live.streamTurn()
    expect((await sendRestTestMessage(rig, 'session-live', 'after this')).ok).toBe(true)
    await rig.host.flushStreamedEvents('session-live')
    const queued = rig.host['sessions']
      .get('session-live')!
      .journal.submissions()
      .filter((submission) => submission.handedOverAt === undefined)
    expect(queued).toHaveLength(1)
    expect(rig.host['clientDelivery'].chatWork.sendInFlight()).toBe(false)

    rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS
    await job.tick()
    expect(await perChatFilesLeft(rig)).toBe(0)
  })

  it.each([
    ['is parked on an approval', (live: LiveTestChat) => live.askUnderTurn()],
    ['runs a turn that has gone silent (a long tool call)', async () => undefined]
  ] as const)(
    'copies every chat once a chat that %s has sent no frame for the quiet period',
    async (_case, park) => {
      const { rig, live } = await oldChatsAndALiveOne()
      const importJournal = rowPerBatchImport()
      const job = copyJob(rig, { importJournal })
      await live.streamTurn()
      await park(live)
      const rows = rig.statusEvents.flatMap((event) =>
        event.type === 'status' && event.session.sessionId === 'session-live'
          ? [event.session.status]
          : []
      )
      // Its turn is still running: the row reads working, or attention over the prompt.
      expect(['working', 'attention']).toContain(rows.at(-1))

      rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS - 1
      await job.tick()
      expect(importJournal).not.toHaveBeenCalled()

      rig.copyClock.now += 1
      await job.tick()
      expect(await perChatFilesLeft(rig)).toBe(0)
      expect(OLD.map((sessionId) => published(rig, sessionId))).toEqual([{ n: 1 }, { n: 1 }])
    }
  )

  it('times the quiet period from the last frame, which a tick need not see', async () => {
    const { rig, live } = await oldChatsAndALiveOne()
    const importJournal = rowPerBatchImport()
    const job = copyJob(rig, { importJournal })
    await live.streamTurn()
    rig.copyClock.now += 3_000
    live.frame()

    rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS - 1
    await job.tick()
    expect(importJournal).not.toHaveBeenCalled()

    rig.copyClock.now += 1
    await job.tick()
    expect(await perChatFilesLeft(rig)).toBe(0)
  })

  it.each([
    ['opens a turn', (live: LiveTestChat) => live.streamTurn()],
    ['streams a delta that writes no row', async (live: LiveTestChat) => live.frame()]
  ] as const)(
    'stops the chat whose copy is under way at its next batch when a chat %s',
    async (_case, work) => {
      const { rig, live } = await oldChatsAndALiveOne()
      let yieldsAfterWork = 0
      let working = false
      const importJournal = rowPerBatchImport(async (yields) => {
        if (working) {
          yieldsAfterWork += 1
        } else if (yields === 2) {
          working = true
          await work(live)
        }
      })
      const deps = copyJobDeps(rig)
      const job = copyJob(rig, { ...deps, importJournal })

      await job.tick()

      // Its next batch never ran: the copy publishes nothing, and the chat is still owed.
      expect(importJournal).toHaveBeenCalledOnce()
      const stopped = importJournal.mock.calls[0][0].identity.sessionId
      expect(yieldsAfterWork).toBe(0)
      expect(published(rig, stopped)).toEqual({ n: 0 })
      // Its first page went in, unpublished; the next page's read never ran.
      expect(rowsOf(rig, stopped)).toEqual({ n: 1 })
      expect(hasPerChatFile(rig, stopped)).toBe(true)
      expect(await perChatFilesLeft(rig)).toBe(OLD.length)
      // Not a failure: nothing recorded, no settle.
      expect(failuresRecorded(rig)).toEqual({ n: 0 })
      expect(deps.settleClosedChat).not.toHaveBeenCalled()
      expect(job.isFinished).toBe(false)

      rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS
      await job.tick()

      // The same chat first, its staged rows cleared before its copy goes in again.
      expect(importJournal.mock.calls[1]?.[0].identity.sessionId).toBe(stopped)
      expect(await perChatFilesLeft(rig)).toBe(0)
      expect(rowsOf(rig, stopped)).toEqual(
        rowsOf(
          rig,
          OLD.find((id) => id !== stopped)!
        )
      )
      expect(OLD.map((sessionId) => published(rig, sessionId))).toEqual([{ n: 1 }, { n: 1 }])
    }
  )

  it('leaves nothing half-copied, whichever of a chat’s task boundaries a chat starting work stops it at', async () => {
    // Every boundary of one chat's copy: between copy batches, between verify batches, before the
    // publish, and the last, after it.
    const probe = await oldChatsAndALiveOne()
    const counted: Record<string, number> = {}
    const counting = vi.fn((input: Parameters<typeof importPerSessionJournal>[0]) =>
      rowPerBatchImport(async (yields) => {
        counted[input.identity.sessionId] = yields
      })(input)
    )
    await copyJob(probe.rig, { importJournal: counting }).tick()
    const boundaries = counted[OLD[0]]
    expect(boundaries).toBeGreaterThan(4)

    for (let at = 1; at <= boundaries; at += 1) {
      const { rig, live, statusBefore } = await oldChatsAndALiveOne()
      const inFile = Object.fromEntries(OLD.map((id) => [id, storedInFile(rig, id)]))
      let stoppedAt = 0
      let derivesAtStop = 0
      const importJournal = vi.fn((input: Parameters<typeof importPerSessionJournal>[0]) =>
        rowPerBatchImport(async (yields) => {
          if (stoppedAt === 0 && yields === at) {
            stoppedAt = yields
            await live.streamTurn()
            derivesAtStop = vi.mocked(deriveJournalSessionStatus).mock.calls.length
          }
        })(input)
      )
      const job = copyJob(rig, { importJournal })
      await job.tick()
      expect(stoppedAt).toBe(at)
      if (at < boundaries) {
        // Nothing after the stop, the status derive before the publish included.
        expect(vi.mocked(deriveJournalSessionStatus).mock.calls.length, `boundary ${at}`).toBe(
          derivesAtStop
        )
      }
      // Past the publish the copy is whole, and the chat it stopped is copied.
      const filesLeft = at < boundaries ? OLD.length : OLD.length - 1
      expect(await perChatFilesLeft(rig), `boundary ${at} of ${boundaries}`).toBe(filesLeft)

      await live.endTurn()
      rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS
      await job.tick()

      expect(await perChatFilesLeft(rig)).toBe(0)
      for (const sessionId of OLD) {
        // Exactly the file's rows, once, under its one epoch, with the chat's status row.
        const copied = storedChat(openTestJournalHostDatabase(rig.root).db, sessionId)
        expect(copied, `stopped at boundary ${at}`).toEqual(inFile[sessionId])
        expect(copied.epochs).toHaveLength(1)
        expect(statusRow(rig, sessionId)).toEqual(statusBefore[sessionId])
      }
    }
  }, 60_000)

  it('opens no old file when a chat started working between the gate and the chat', async () => {
    const { rig, live } = await oldChatsAndALiveOne()
    const openSource = vi.fn(openLegacySource)
    const importJournal = rowPerBatchImport()
    let probes = 0
    const job = copyJob(rig, {
      importJournal: (input) => importJournal({ ...input, openSource }),
      // The disk probe, after the walk: a turn starts while it runs.
      freeBytes: async () => {
        probes += 1
        if (probes === 1) {
          await live.streamTurn()
        }
        return null
      }
    })

    await job.tick()

    expect(probes).toBe(1)
    expect(openSource).not.toHaveBeenCalled()
    expect(await perChatFilesLeft(rig)).toBe(OLD.length)
    expect(failuresRecorded(rig)).toEqual({ n: 0 })

    await live.endTurn()
    rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS
    await job.tick()
    expect(await perChatFilesLeft(rig)).toBe(0)
    expect(openSource).toHaveBeenCalled()
  })

  it('leaves the settle of a chat it copied to startup when a chat starts working after the publish', async () => {
    const rig = await createCopyTestRig()
    rigs.push(rig)
    // A chat a crash cut mid-turn, now in its old file.
    const crashed = await openLiveChat(rig, 'session-crashed')
    await crashed.streamTurn()
    await rig.crash()
    moveToPerChatFiles(rig, ['session-crashed'])
    await rig.boot()
    const live = await openLiveChat(rig, 'session-live')
    const deps = copyJobDeps(rig)
    let published = false
    const importJournal = vi.fn((input: Parameters<typeof importPerSessionJournal>[0]) =>
      rowPerBatchImport(async () => {
        // The importer's last task boundary, after the publish.
        if (
          !published &&
          openTestJournalHostDatabase(rig.root)
            .db.prepare("SELECT 1 FROM journal_sessions WHERE session_id = 'session-crashed'")
            .get()
        ) {
          published = true
          await live.streamTurn()
        }
      })(input)
    )
    const job = copyJob(rig, { ...deps, importJournal })

    await job.tick()

    expect(published).toBe(true)
    expect(await perChatFilesLeft(rig)).toBe(0)
    expect(deps.settleClosedChat).not.toHaveBeenCalled()
    // Startup settles the row the copy wrote.
    expect(statusRow(rig, 'session-crashed')).toMatchObject({ lifecycle: 'running' })
  })

  it('stops a missing status row the same way, writing nothing, and writes it once quiet', async () => {
    const rig = await createCopyTestRig()
    rigs.push(rig)
    // A fold long enough to take more than one task.
    await restTestChat(rig, 'session-rowless', { listed: false, message: 'x'.repeat(600_000) })
    await rig.crash()
    const before = statusRow(rig, 'session-rowless')
    openTestJournalHostDatabase(rig.root)
      .db.prepare("DELETE FROM journal_session_state WHERE session_id = 'session-rowless'")
      .run()
    await rig.boot()
    const live = await openLiveChat(rig, 'session-live')
    const deps = copyJobDeps(rig)
    const inChat = deps.pace!.inChat.bind(deps.pace)
    let yieldsAfterWork = 0
    let working = false
    vi.spyOn(deps.pace!, 'inChat').mockImplementation((serialize, sessionId, task) =>
      inChat(serialize, sessionId, (yieldTask) =>
        task(async () => {
          await yieldTask()
          if (sessionId !== 'session-rowless') {
            return
          }
          if (working) {
            yieldsAfterWork += 1
          } else {
            working = true
            await live.streamTurn()
          }
        })
      )
    )
    const job = copyJob(rig, deps)

    await job.tick()

    expect(working).toBe(true)
    expect(yieldsAfterWork).toBe(0)
    expect(
      hasJournalSessionStatus(openTestJournalHostDatabase(rig.root).db, 'session-rowless')
    ).toBe(false)
    expect(failuresRecorded(rig)).toEqual({ n: 0 })
    expect(job.isFinished).toBe(false)

    await live.endTurn()
    rig.copyClock.now += PER_CHAT_FILE_COPY_QUIET_MS
    await job.tick()

    expect(job.isFinished).toBe(true)
    // The row a whole fold writes, once.
    expect(statusRow(rig, 'session-rowless')).toEqual(before)
  })
})

describe('one chat’s copy', () => {
  it('starts stopped when a send went in flight after the gate let it through', () => {
    let inFlight = false
    const activity = new StructuredAgentSessionPerChatFileCopyActivity({
      chatWork: { sendInFlight: () => inFlight, onActivity: () => () => undefined },
      now: () => 0
    })
    expect(activity.quiet()).toBe(true)
    inFlight = true

    const chat = activity.forChat(new AbortController().signal)

    expect(chat.signal.aborted).toBe(true)
    expect(chat.stoppedByWork()).toBe(true)
  })
})

describe('a send in flight, read once per journal tip', () => {
  function chat() {
    const submissions = new Map<string, AgentJournalSubmission>()
    const state = { sequence: 1, fence: 1 }
    const read = vi.fn(() => [...submissions.values()])
    const journal = {
      isReadOnly: false,
      cursor: () => ({ epoch: 'epoch-1', sequence: state.sequence }),
      submissions: read
    }
    const entry: { journal: typeof journal; child: { phase: 'ready' | 'starting' } | null } = {
      journal,
      child: { phase: 'ready' }
    }
    const open = new Map([['chat', entry]])
    const activity = new StructuredAgentSessionChatActivity({
      sessions: open,
      fence: () => state.fence
    })
    const pending: AgentJournalSubmission = {
      clientMessageId: 'send-1',
      fence: 1,
      payloadFingerprint: '',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null,
      handoverRecorded: true,
      acceptedSequence: 1,
      origin: 'host'
    }
    return {
      activity,
      read,
      state,
      open,
      send: (submission: Partial<AgentJournalSubmission>) => {
        submissions.set('send-1', { ...pending, ...submission })
        state.sequence += 1
      }
    }
  }

  it('walks a chat’s sends only when its tip, fence or agent moved', () => {
    const { activity, read, state, open, send } = chat()
    expect(activity.sendInFlight()).toBe(false)
    expect(activity.sendInFlight()).toBe(false)
    expect(read).toHaveBeenCalledOnce()

    // A send handed over: a new row moves the tip.
    send({ handedOverAt: 2 })
    expect(activity.sendInFlight()).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    // Answered: the tip moves again.
    send({ handedOverAt: 2, dispatchState: 'accepted' })
    expect(activity.sendInFlight()).toBe(false)

    // Queued behind a ready agent: not in flight; the same send while its agent starts: in flight.
    send({})
    expect(activity.sendInFlight()).toBe(false)
    open.get('chat')!.child = { phase: 'starting' }
    expect(activity.sendInFlight()).toBe(true)

    // The child ended: its fence moved past the send, which is no longer in flight.
    send({ handedOverAt: 2 })
    expect(activity.sendInFlight()).toBe(true)
    state.fence = 2
    expect(activity.sendInFlight()).toBe(false)
  })
})
