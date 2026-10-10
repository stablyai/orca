// Startup owes a latched recovery only to the chats its restart restore makes readable, the visible
// tabs: deciding it may stop a surviving agent. When the restore's own reconcile or recovery write
// meets another connection's lock, the host's retry decides it instead, round after round, until it
// lands; and a chat a reader only opened behind them (an orchestration worker's history, a mailbox
// pointer, an outline, a naming read) is never decided, so its agent is never signalled.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  openScanHost,
  scanRecord as record,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'

const CHAT = 'chat-aaaaaaa1'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-restore-recovery-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = undefined
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const busy = () =>
  Object.assign(new Error('database is locked'), { errcode: 5, code: 'SQLITE_BUSY' })

/** A chat whose agent outlived the earlier process, and whose first `locked` reconciles meet a
 *  lock: its lease reconciles to `recovering`, and only stopping the agent decides it. */
async function survivingAgent(locked: number) {
  await seedTestAgentSessionRecordStore(root, { records: [record(CHAT, false)] })
  await seedScanJournal(root, CHAT)
  store = await openTestAgentSessionRecordStore(root)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const reconcile = vi.spyOn(store, 'reconcileOnRestart')
  for (let index = 0; index < locked; index += 1) {
    reconcile.mockRejectedValueOnce(busy())
  }
  let alive = true
  const stopOwnerProcess = vi.fn(() => {
    alive = false
  })
  const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
    alive ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] } : { outcome: 'pid-absent' }
  host = openScanHost(root, store, { probeOwner, stopOwnerProcess })
  return { current: host, stopOwnerProcess }
}

it("never stops a hidden chat's agent that readers only read, after reconciles a lock refused", async () => {
  const { current, stopOwnerProcess } = await survivingAgent(2)
  await current.reconcileRestartLeases()
  expect(store.getRecord(CHAT)?.lease.unreconciled).toBe(true)

  // Every reader that opens a chat no tab shows.
  await current.history({ sessionId: CHAT, direction: 'tail' }, 'own-agent') // worker-show
  await current.journalSnapshot(CHAT) // a mailbox pointer
  await current.journalSnapshot(CHAT) // the conversation outline
  await current.journalSnapshot(CHAT) // a naming read
  await vi.waitFor(() => expect(store.getRecord(CHAT)?.lease.unreconciled).toBe(false), {
    timeout: 8_000
  })
  // Rounds enough for anything that would decide it.
  await new Promise((resolve) => setTimeout(resolve, 3_000))

  expect(stopOwnerProcess).not.toHaveBeenCalled()
  expect(store.getRecord(CHAT)?.lease.handoffStage).toBe('recovering')
}, 20_000)

it("retries a visible chat's recovery its write could not land, until it does", async () => {
  // Startup's, the restore's and the first round's reconciles meet the lock.
  const { current, stopOwnerProcess } = await survivingAgent(3)
  const transition = store.transitionHandoff
  let refused = 0
  vi.spyOn(store, 'transitionHandoff').mockImplementation((...args) => {
    // The lock is back for the recovery's own write, once.
    if (args[2]?.background && refused === 0) {
      refused += 1
      return Promise.reject(busy())
    }
    return transition(...args)
  })

  await current.reconcileRestartLeases()
  await current.restoreReadableSessions([CHAT])

  await vi.waitFor(() => expect(refused).toBe(1), { timeout: 8_000 })
  await vi.waitFor(() => expect(store.getRecord(CHAT)?.lease.handoffStage).toBeNull(), {
    timeout: 8_000
  })
  expect(stopOwnerProcess).toHaveBeenCalled()
  expect(current.currentWork(CHAT)?.working()).toBe(false)
}, 30_000)
