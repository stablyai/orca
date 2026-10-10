// Startup's lease reconcile, failed because another connection held the database, is retried for
// every chat as ONE store-wide step of the retry's round: one call per round however many chats
// wait on it, so N chats never stack N waits on a busy store, and it never stops a process.

import { DatabaseSync } from 'node:sqlite'
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
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  openScanHost,
  scanRecord,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined
let locker: DatabaseSync | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-restart-reconcile-retry-'))
})

afterEach(async () => {
  try {
    locker?.exec('ROLLBACK')
  } catch {
    // Never begun.
  }
  locker?.close()
  locker = undefined
  await host?.flushAllStreamedEvents()
  host = undefined
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function seedChats(count: number, released: boolean): Promise<string[]> {
  const chats = Array.from({ length: count }, (_, i) => `chat-r${String(i).padStart(6, '0')}`)
  await seedTestAgentSessionRecordStore(root, {
    records: chats.map((id) => scanRecord(id, released))
  })
  for (const id of chats) {
    await seedScanJournal(root, id)
  }
  store = await openTestAgentSessionRecordStore(root)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  return chats
}

describe('a failed startup reconcile, retried by every chat that waits on it', () => {
  it('runs once per backoff step for 40 chats, and stops no process', async () => {
    await seedChats(40, false)
    const reconcile = vi
      .spyOn(store, 'reconcileOnRestart')
      .mockRejectedValue(Object.assign(new Error('database is locked'), { errcode: 5 }))
    const stops: unknown[] = []
    host = openScanHost(root, store, {
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      stopOwnerProcess: (...args) => stops.push(args)
    })

    await host.reconcileRestartLeases()
    await new Promise((resolve) => setTimeout(resolve, 3_500))

    // Startup, then the shared retry at 0 s, 1 s and 3 s: never one per chat.
    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(reconcile.mock.calls.length).toBeLessThanOrEqual(4)
    expect(stops).toEqual([])
  })

  it('meets a real write lock once per round for 40 chats, never once per chat', async () => {
    await seedChats(40, true)
    expect(store.listRecords().every((record) => record.lease.unreconciled)).toBe(true)
    openTestJournalHostDatabase(root).db.pragma('busy_timeout = 300')
    const reconcile = vi.spyOn(store, 'reconcileOnRestart')
    locker = new DatabaseSync(join(root, 'agent-session-journal.db'))
    locker.exec('BEGIN IMMEDIATE')
    host = openScanHost(root, store)

    await host.reconcileRestartLeases()
    await new Promise((resolve) => setTimeout(resolve, 4_000))

    // Startup's own, then one per round at 0 s, 1 s and 3 s: background, so each fails at once.
    expect(reconcile.mock.calls.length).toBeLessThanOrEqual(5)
    expect(store.listRecords().every((record) => record.lease.unreconciled)).toBe(true)

    // The lock lifts: the next step reconciles every lease.
    locker.exec('ROLLBACK')
    await vi.waitFor(
      () => expect(store.listRecords().some((record) => record.lease.unreconciled)).toBe(false),
      { timeout: 10_000 }
    )
  })
})
