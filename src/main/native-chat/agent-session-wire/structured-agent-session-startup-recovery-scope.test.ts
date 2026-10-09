// What startup decides about a lease latched in recovery: nothing, for a chat nobody looks at.
// Deciding it signals a process that may still run, so only the visible-tab restore, a start or an
// attach does; that decision's release then wakes the chat's worker, which settles what it left.

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
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
async function openWithSurvivingOwner() {
  await seedTestAgentSessionRecordStore(root, { records: [record(CHAT, false)] })
  await seedScanJournal(root, CHAT)
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
    const open = vi.spyOn(AgentSessionJournal.prototype, 'open')

    await current.reconcileRestartLeases()
    await current.startupSettled()
    await idle(current, [CHAT])

    // No signal to a process that may still run, no lease change, and not even a read.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(CHAT)?.lease).toMatchObject({
      handoffStage: 'recovering',
      runtimeFence: 13,
      ownerProcess: { pid: OWNER_PID }
    })
    expect(open).not.toHaveBeenCalled()

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
