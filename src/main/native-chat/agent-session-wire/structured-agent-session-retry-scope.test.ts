// What a round of the host's retry touches: a chat's replay is read once however many rounds a
// lock refuses, a latch that comes after the restart restore waits for its own chat, and nothing
// the store-wide step cannot decide holds the other chats back or is probed round after round.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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
import * as reconciliationLoad from './structured-agent-session-reconciliation-load'
import * as reconciliationPass from './structured-agent-session-reconciliation-pass'
import {
  openScanHost,
  scanIdle,
  scanRecord,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'

const CHAT = 'chat-aaaaaaa1'
const OTHER = 'chat-aaaaaaa2'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-retry-scope-'))
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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Records and journals for `ids`; `alive` names chats whose agent outlived the earlier process. */
async function seed(ids: readonly string[], alive: readonly string[] = []) {
  await seedTestAgentSessionRecordStore(root, {
    records: ids.map((id) => scanRecord(id, !alive.includes(id)))
  })
  for (const id of ids) {
    await seedScanJournal(root, id)
  }
  store = await openTestAgentSessionRecordStore(root)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
}

/** Every pass on `contended` chats meets a lock while `held()`; the rest run as they are. */
function lockPasses(held: () => boolean, contended: (sessionId: string) => boolean) {
  const pass = reconciliationPass.runStructuredAgentSessionReconciliationPass
  return vi
    .spyOn(reconciliationPass, 'runStructuredAgentSessionReconciliationPass')
    .mockImplementation(async (...args) =>
      held() && contended(args[1])
        ? { failed: [busy()], wrote: false, recovering: false }
        : pass(...args)
    )
}

function surviving() {
  let alive = true
  const probeOwner = vi.fn(async (): Promise<AgentSessionOwnerProbe> =>
    alive ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] } : { outcome: 'pid-absent' }
  )
  const stopOwnerProcess = vi.fn(() => {
    alive = false
  })
  return { probeOwner, stopOwnerProcess }
}

const latch = (lease: Partial<AgentSessionRecord['lease']>) => (record: AgentSessionRecord) => ({
  ...record,
  lease: { ...record.lease, handoffStage: 'recovering' as const, ...lease }
})

it('replays each of 20 closed chats once while a lock refuses round after round', async () => {
  const chats = Array.from({ length: 20 }, (_, i) => `chat-r${String(i).padStart(6, '0')}`)
  await seed(chats)
  let held = true
  const passes = lockPasses(
    () => held,
    () => true
  )
  const loads = vi.spyOn(reconciliationLoad, 'loadStructuredAgentSessionForReconciliation')
  host = openScanHost(root, store)
  await host.reconcileRestartLeases()

  // Rounds at 0 s, 1 s, 3 s and 5 s, each stopped by the lock.
  await pause(5_500)
  expect(passes.mock.calls.length).toBeGreaterThanOrEqual(3)
  held = false
  await scanIdle(host, chats)

  expect(loads.mock.calls.length).toBeLessThanOrEqual(20)
}, 30_000)

it("never signals a restored chat's agent for a latch that came after the restore", async () => {
  await seed([CHAT, OTHER])
  const { probeOwner, stopOwnerProcess } = surviving()
  host = openScanHost(root, store, { probeOwner, stopOwnerProcess })
  await host.reconcileRestartLeases()
  await host.restoreReadableSessions([CHAT])
  await scanIdle(host, [CHAT, OTHER])
  const probes = probeOwner.mock.calls.length

  // Mid-session its lease latches, its owner alive; another chat's rounds run.
  const { ownerProcess, reservedSpawnToken } = scanRecord(CHAT, false).lease
  await store.transitionHandoff(
    CHAT,
    latch({ ownerProcess, reservedSpawnToken, claimStatus: 'reserved' })
  )
  let held = true
  lockPasses(
    () => held,
    (sessionId) => sessionId === OTHER
  )
  host.collaboratorsForTests().reconciliation.signal(OTHER)
  await pause(3_500)
  held = false
  await scanIdle(host, [OTHER])

  expect(stopOwnerProcess).not.toHaveBeenCalled()
  expect(probeOwner).toHaveBeenCalledTimes(probes)
  expect(store.getRecord(CHAT)?.lease.handoffStage).toBe('recovering')
}, 30_000)

it('on a read-only store, attempts no store-wide step and still visits the other chats', async () => {
  await seed([CHAT, OTHER], [CHAT])
  // A newer Orca wrote the database: a latched lease here stays latched.
  Object.defineProperty(openTestJournalHostDatabase(root), 'readOnly', { value: true })
  const { probeOwner, stopOwnerProcess } = surviving()
  host = openScanHost(root, store, { probeOwner, stopOwnerProcess })
  await host.reconcileRestartLeases()
  await host.restoreReadableSessions([CHAT])
  expect(store.getRecord(CHAT)?.lease.handoffStage).toBe('recovering')
  const reconcile = vi.spyOn(store, 'reconcileOnRestart')
  const probes = probeOwner.mock.calls.length
  const stops = stopOwnerProcess.mock.calls.length

  host.collaboratorsForTests().reconciliation.signal(OTHER)
  await scanIdle(host, [CHAT, OTHER])
  await pause(3_500)

  expect(reconcile).not.toHaveBeenCalled()
  expect(probeOwner).toHaveBeenCalledTimes(probes)
  expect(stopOwnerProcess).toHaveBeenCalledTimes(stops)
}, 30_000)

it.each([
  ['a conflicted claim', { claimStatus: 'conflicted' as const }],
  [
    'an owner on another host',
    {
      ownerProcess: { hostId: 'other', pid: 12_000, processStartTimeMs: 0, spawnToken: 'spawn' }
    }
  ]
])(
  'never re-probes %s round after round',
  async (_name, lease) => {
    await seed([CHAT, OTHER], [CHAT])
    const { probeOwner, stopOwnerProcess } = surviving()
    host = openScanHost(root, store, { probeOwner, stopOwnerProcess })
    await host.reconcileRestartLeases()
    expect(store.getRecord(CHAT)?.lease.handoffStage).toBe('recovering')
    await store.transitionHandoff(CHAT, latch(lease))
    await host.restoreReadableSessions([CHAT])
    await scanIdle(host, [CHAT])
    const probes = probeOwner.mock.calls.length

    // Another chat's rounds, refused by a lock at 0 s, 1 s and 3 s.
    let held = true
    lockPasses(
      () => held,
      (sessionId) => sessionId === OTHER
    )
    host.collaboratorsForTests().reconciliation.signal(OTHER)
    await pause(3_500)
    held = false
    await scanIdle(host, [OTHER])

    expect(probeOwner).toHaveBeenCalledTimes(probes)
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(CHAT)?.lease.handoffStage).toBe('recovering')
  },
  30_000
)
