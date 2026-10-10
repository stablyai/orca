// Startup's scan of every chat on record: in the background, never ahead of a person's own action
// on a chat, with no stored mark saying which chats are owed anything.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  openScanHost,
  SCAN_CHATS as CHATS,
  SCAN_LATE as LATE,
  SCAN_RELEASED as RELEASED,
  scanIdle as idle,
  scanRecord as record,
  scanTurnState as turnState,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'
import { retryOwes } from './structured-agent-session-retry.test-fixture'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined

function openHost(): StructuredAgentSessionHost {
  host = openScanHost(root, store)
  return host
}

/** The chats each pass ran on, in order: every pass repairs the cards an earlier handle left. */
function watchPasses(): string[] {
  const passes: string[] = []
  const repair = JournalQueuedMessages.prototype.repairAndPrune
  vi.spyOn(JournalQueuedMessages.prototype, 'repairAndPrune').mockImplementation(function (
    this: JournalQueuedMessages
  ) {
    passes.push(this.sessionId)
    return repair.call(this)
  })
  return passes
}

/** Holds the first four journal opens (every background slot); `opened` lists each chat whose
 *  open began, in order. */
function gateFirstOpens(): { opened: string[]; releaseOne: () => void; release: () => void } {
  const held: (() => void)[] = []
  const opened: string[] = []
  const open = AgentSessionJournal.prototype.open
  vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function (
    this: AgentSessionJournal
  ) {
    opened.push(this.queuedMessages.sessionId)
    if (opened.length <= 4) {
      await new Promise<void>((resolve) => held.push(resolve))
    }
    return open.call(this)
  })
  return {
    opened,
    releaseOne: () => held.shift()?.(),
    release: () => held.splice(0).forEach((resolve) => resolve())
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-scan-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = undefined
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('the startup scan', () => {
  it('never puts a chat late in the scan behind its own share, and settles it without publishing it', async () => {
    const all = [...CHATS, LATE]
    await seedTestAgentSessionRecordStore(root, { records: all.map((id) => record(id, false)) })
    for (const sessionId of all) {
      await seedScanJournal(root, sessionId)
    }
    store = await openTestAgentSessionRecordStore(root)
    const { opened, release } = gateFirstOpens()
    const current = openHost()
    const indexed: string[] = []
    const { sessions, serialize } = current.collaboratorsForTests()
    const set = sessions.set.bind(sessions)
    vi.spyOn(sessions, 'set').mockImplementation((sessionId, session) => {
      indexed.push(sessionId)
      return set(sessionId, session)
    })
    const shares = watchPasses()

    await current.reconcileRestartLeases()
    await vi.waitFor(() => expect(opened).toHaveLength(4))

    // The person's own actions on the late chat run now, ahead of its share.
    const order: string[] = []
    await serialize(LATE, async () => {
      order.push('lane')
    })
    expect(await turnState(current, LATE)).toBe('running')
    order.push('read')
    expect(shares).not.toContain(LATE)

    release()
    await current.startupSettled()
    await idle(current, all)
    expect(order).toEqual(['lane', 'read'])
    expect(new Set(shares)).toEqual(new Set(all))
    // Only the chat a reader opened is a conversation; the scan's own reads published nothing.
    expect(indexed).toEqual([LATE])
    for (const sessionId of all) {
      expect(await turnState(current, sessionId)).toBe('interrupted')
    }
  })

  it('takes a chat a reader opens ahead of the rest of the scan', async () => {
    const all = [...CHATS, LATE]
    // Released: the restart reconcile ends nothing, so each chat's first attempt is its share.
    await seedTestAgentSessionRecordStore(root, { records: all.map((id) => record(id, true)) })
    for (const sessionId of all) {
      await seedScanJournal(root, sessionId)
    }
    store = await openTestAgentSessionRecordStore(root)
    const { opened, releaseOne, release } = gateFirstOpens()
    const current = openHost()
    const passes = watchPasses()

    await current.reconcileRestartLeases()
    await vi.waitFor(() => expect(opened).toHaveLength(4))
    expect(opened).not.toContain(LATE)
    // The person opens the late chat while two chats still wait for a slot, it among them.
    expect(await turnState(current, LATE)).toBe('running')

    // One slot comes free: the late chat takes it ahead of the chat queued before it.
    releaseOne()
    await vi.waitFor(() => expect(passes).toContain(LATE))
    release()
    await current.startupSettled()
    await idle(current, all)
    expect(passes.indexOf(LATE)).toBeLessThan(passes.indexOf(CHATS[4]!))
    expect(await turnState(current, LATE)).toBe('interrupted')
  })

  it('finds what an earlier process left with no fence move and no stored mark, and keeps its send as a card', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [record(RELEASED, true)] })
    await seedScanJournal(root, RELEASED, { queued: true })
    store = await openTestAgentSessionRecordStore(root)
    const current = openHost()
    const ended = vi.fn()
    store.onGenerationEnded(ended)

    await current.reconcileRestartLeases()
    await current.startupSettled()
    await idle(current, [RELEASED])

    // Already released: the restart moved nothing and ended no generation.
    expect(ended).not.toHaveBeenCalled()
    expect(store.getRecord(RELEASED)?.lease.runtimeFence).toBe(14)
    // Nothing proved its owner gone, but the runtime that held it was replaced, which ends it.
    expect(await turnState(current, RELEASED)).toBe('interrupted')
    const { journal } = current.collaboratorsForTests().sessions.get(RELEASED)!
    expect(journal.submission(`${RELEASED}-queued`)).toMatchObject({ dispatchState: 'rejected' })
    expect(journal.queuedMessages.list()).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ role: 'user' }) })
    ])
  })

  it('retries a conversion that failed instead of marking it done', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [record(RELEASED, true)] })
    await seedScanJournal(root, RELEASED, { queued: true })
    store = await openTestAgentSessionRecordStore(root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const database = openTestJournalHostDatabase(root)
    database.db.exec(`
      CREATE TEMP TRIGGER reject_conversion BEFORE INSERT ON journal_rows
      WHEN json_extract(NEW.row_json, '$.kind') = 'dispatch'
        AND json_extract(NEW.row_json, '$.state') = 'rejected'
      BEGIN SELECT RAISE(ABORT, 'temporary storage failure'); END;
    `)
    const current = openHost()

    await current.reconcileRestartLeases()
    await current.startupSettled()
    const { reconciliation } = current.collaboratorsForTests()
    expect(retryOwes(reconciliation, RELEASED)).toBe(true)

    database.db.exec('DROP TRIGGER reject_conversion')
    await idle(current, [RELEASED])

    expect(await turnState(current, RELEASED)).toBe('interrupted')
    const { journal } = current.collaboratorsForTests().sessions.get(RELEASED)!
    expect(journal.submission(`${RELEASED}-queued`)).toMatchObject({ dispatchState: 'rejected' })
    expect(journal.queuedMessages.list()).toHaveLength(1)
  })
})
