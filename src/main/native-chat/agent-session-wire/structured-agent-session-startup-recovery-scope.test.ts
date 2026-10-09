// What startup decides about a lease latched in recovery: nothing, for a chat nobody looks at.
// Deciding it signals a process that may still run, so only the visible-tab restore, a start or an
// attach does; that decision's release then wakes the chat's worker, which settles what it left.
// What the earlier process left unsent is kept as a card meanwhile, as every open did on main.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  openScanHost,
  scanIdle as idle,
  scanRecord as record,
  scanTurnState as turnState,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'

const CHAT = 'chat-aaaaaaa1'
const OWNER_PID = 12_000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined

/** The earlier process's agent outlived it, until something stops it. */
async function openWithSurvivingOwner(options: Parameters<typeof seedScanJournal>[2] = {}) {
  await seedTestAgentSessionRecordStore(root, { records: [record(CHAT, false)] })
  await seedScanJournal(root, CHAT, options)
  store = await openTestAgentSessionRecordStore(root)
  let alive = true
  const stopOwnerProcess = vi.fn((_pid: number, _signal: 'SIGTERM' | 'SIGKILL') => {
    alive = false
  })
  const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
    alive ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] } : { outcome: 'pid-absent' }
  host = openScanHost(root, store, { probeOwner, stopOwnerProcess })
  return { current: host, stopOwnerProcess }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-recovery-scope-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = undefined
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a hidden chat whose agent outlived the earlier process', () => {
  it('is left alone at startup, and settled once an attach decides its recovery', async () => {
    const { current, stopOwnerProcess } = await openWithSurvivingOwner()

    await current.reconcileRestartLeases()
    await current.startupSettled()
    await idle(current, [CHAT])

    // No signal to a process that may still run, and no lease change.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(CHAT)?.lease).toMatchObject({
      handoffStage: 'recovering',
      runtimeFence: 13,
      ownerProcess: { pid: OWNER_PID }
    })

    // The person attaches: recovery is decided first, as on every build, stopping the owner.
    const params = attachParamsForRecord(store.getRecord(CHAT)!, {
      clientOperationId: 'attach-1',
      expectedRuntimeFence: 13
    })
    await current.attach({ callerKey: 'client-1' }, params).catch(() => undefined)

    expect(stopOwnerProcess).toHaveBeenCalledWith(OWNER_PID, 'SIGTERM')
    expect(store.getRecord(CHAT)?.lease).toMatchObject({ handoffStage: null, ownerProcess: null })
    // Its release woke the worker, which settles the turn the owner left by that proof.
    await idle(current, [CHAT])
    expect(await turnState(current, CHAT)).toBe('interrupted')
  })
})

describe("a hidden chat's send the earlier process never handed over, while its lease recovers", () => {
  it('is a card once the chat is read, with no attach and no decision about the owner', async () => {
    // Accepted at the owner's own fence, which the lease still holds.
    const { current, stopOwnerProcess } = await openWithSurvivingOwner({
      queued: true,
      queuedFence: 13
    })

    await current.reconcileRestartLeases()
    await current.startupSettled()
    await idle(current, [CHAT])
    // Desktop opens a chat by reading it.
    const page = await current.history({ sessionId: CHAT, direction: 'tail' })
    const { submissions } = await current.journalSnapshot(CHAT)

    expect(page.ok && page.page.queuedMessages?.map((card) => card.messageId)).toEqual([
      `${CHAT}-queued`
    ])
    expect(submissions.find((entry) => entry.clientMessageId === `${CHAT}-queued`)).toMatchObject({
      dispatchState: 'rejected'
    })
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(CHAT)?.lease).toMatchObject({
      handoffStage: 'recovering',
      runtimeFence: 13,
      ownerProcess: { pid: OWNER_PID }
    })
    // What the owner left running waits for the decision: no verdict yet.
    expect(await turnState(current, CHAT)).toBe('running')
  })
})

describe('a visible chat whose agent outlived the earlier process', () => {
  it('has its owner stopped by the visible-tab restore, as before', async () => {
    const { current, stopOwnerProcess } = await openWithSurvivingOwner()

    await current.reconcileRestartLeases()
    await current.restoreReadableSessions([CHAT])

    expect(stopOwnerProcess).toHaveBeenCalledWith(OWNER_PID, 'SIGTERM')
    expect(store.getRecord(CHAT)?.lease).toMatchObject({ handoffStage: null, ownerProcess: null })
    await current.startupSettled()
    await idle(current, [CHAT])
    expect(await turnState(current, CHAT)).toBe('interrupted')
  })
})

describe('a chat whose startup lease reconcile failed (storage was busy)', () => {
  it('is reconciled by its worker after a backoff, and its turn settles with no attach or send', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [record(CHAT, false)] })
    await seedScanJournal(root, CHAT)
    store = await openTestAgentSessionRecordStore(root)
    const busy = () => new Error('database is locked')
    // Startup's reconcile and the worker's first retry meet a locked store; the next one lands.
    const reconcile = vi
      .spyOn(store, 'reconcileOnRestart')
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
    host = openScanHost(root, store)
    const current = host

    await current.reconcileRestartLeases()
    expect(store.getRecord(CHAT)?.lease.unreconciled).toBe(true)
    await vi.waitFor(() => expect(store.getRecord(CHAT)?.lease.unreconciled).toBe(false), {
      timeout: 5_000
    })
    await idle(current, [CHAT])

    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(3)
    // The owner was proven gone: the turn ends, and nothing reads working.
    expect(await turnState(current, CHAT)).toBe('interrupted')
    expect(current.currentWork(CHAT)?.working()).toBe(false)
  })
})
