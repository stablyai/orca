// What the retry keeps for a chat whose lease recovers: the proofs it still holds, never an exit's
// account (it judges only its own generation, which a later one may have replaced), and nothing at
// all once the chat's record is gone.

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
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionExitSettlement } from './structured-agent-session-leftover-settlement'
import {
  openScanHost,
  SCAN_NOW,
  scanIdle as idle,
  scanRecord,
  scanTurnState as turnState,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'

const CHAT = 'chat-bbbbbbb1'
let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-parked-debts-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = undefined
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

/** Generation 13 left a running turn; generation 14 outlived the earlier process, holding a send
 *  it was handed and never answered, so its lease is latched in recovery. */
async function recoveringAt14() {
  const base = scanRecord(CHAT, false)
  await seedTestAgentSessionRecordStore(root, {
    records: [
      {
        ...base,
        providerHandleChain: base.providerHandleChain.map((link) => ({
          ...link,
          mintedAtFence: 14
        })),
        lease: { ...base.lease, runtimeFence: 14 }
      }
    ]
  })
  await seedScanJournal(root, CHAT, { handedOverAt: 14 })
  store = await openTestAgentSessionRecordStore(root)
  let alive = true
  const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
    alive ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] } : { outcome: 'pid-absent' }
  host = openScanHost(root, store, {
    probeOwner,
    stopOwnerProcess: () => {
      alive = false
    }
  })
  await host.reconcileRestartLeases()
  await host.startupSettled()
  await idle(host, [CHAT])
  expect(store.getRecord(CHAT)?.lease).toMatchObject({
    handoffStage: 'recovering',
    runtimeFence: 14
  })
  return host
}

const proof13 = {
  kind: 'exit-observed' as const,
  detail: 'generation 13 exited',
  observedAt: SCAN_NOW - 1_000,
  ownerFence: 13
}

/** Generation 13's exit account: it died while still starting. */
const exit13: StructuredAgentSessionExitSettlement = {
  ownerFence: 13,
  settlementId: 'exit-13',
  verdict: { state: 'interrupted', completedAt: SCAN_NOW - 1_000 },
  pendingSubmissionReason: 'provider_exited',
  exitFailure: { kind: 'providerStartFailed' },
  exitedDuringStartup: { generation: 'generation-13' }
}

function attach(current: StructuredAgentSessionHost) {
  const params = attachParamsForRecord(store.getRecord(CHAT)!, {
    clientOperationId: 'attach-1',
    expectedRuntimeFence: 14
  })
  return current.attach({ callerKey: 'client-1' }, params).catch(() => undefined)
}

describe('a chat whose lease recovers', () => {
  it("parks generation 13's proof, never its exit account, which would judge generation 14's sends", async () => {
    const current = await recoveringAt14()
    const { reconciliation } = current.collaboratorsForTests()

    // Generation 13's exit could not be settled; the lease recovers, so the worker retires.
    reconciliation.signal(CHAT, { evidence: proof13, exit: exit13 })
    await idle(current, [CHAT])
    expect(reconciliation['owed'].get(CHAT)).toMatchObject({
      due: false,
      debts: { evidence: [proof13] }
    })
    expect(reconciliation['owed'].get(CHAT)?.debts.exit).toBeUndefined()

    // Generation 14 ends with no exit account of its own: an attach decides its recovery.
    await attach(current)
    await idle(current, [CHAT])

    // The proof judged what generation 13 left, and was taken.
    expect(await turnState(current, CHAT)).toBe('interrupted')
    expect(reconciliation['owed'].has(CHAT)).toBe(false)
    // Generation 14's send ran on a child that proved its start: in doubt, never "did not start".
    const { submissions } = await current.journalSnapshot(CHAT)
    expect(submissions.find((entry) => entry.clientMessageId === `${CHAT}-handed`)).toMatchObject({
      dispatchState: 'unknown'
    })
  })
})

describe('a chat waiting out a backoff with an exit account', () => {
  it("drops it once a later generation acquired, so generation 14's send stays in doubt", async () => {
    const current = await recoveringAt14()
    const { reconciliation } = current.collaboratorsForTests()
    // The pass fails once (storage busy): the worker backs off still holding generation 13's.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(JournalQueuedMessages.prototype, 'repairAndPrune').mockRejectedValueOnce(
      Object.assign(new Error('database is locked'), { errcode: 5 })
    )
    reconciliation.signal(CHAT, { evidence: proof13, exit: exit13 })
    await reconciliation.attempted(CHAT)

    // Generation 14's recovery is decided meanwhile, with no exit account of its own.
    await attach(current)
    await idle(current, [CHAT])

    const { submissions } = await current.journalSnapshot(CHAT)
    expect(submissions.find((entry) => entry.clientMessageId === `${CHAT}-handed`)).toMatchObject({
      dispatchState: 'unknown'
    })
  })
})

describe('a chat whose record is gone', () => {
  it('leaves nothing behind in the reconciliation: no parked proof, no first-open cursor', async () => {
    const current = await recoveringAt14()
    const { reconciliation } = current.collaboratorsForTests()
    reconciliation.signal(CHAT, { evidence: proof13 })
    await idle(current, [CHAT])
    expect(await turnState(current, CHAT)).toBe('running')
    expect(reconciliation['owed'].get(CHAT)?.debts.evidence).toEqual([proof13])
    expect(reconciliation['firstOpened'].has(CHAT)).toBe(true)

    const getRecord = store.getRecord.bind(store)
    vi.spyOn(store, 'getRecord').mockImplementation((id) => (id === CHAT ? null : getRecord(id)))
    reconciliation.signal(CHAT)
    await idle(current, [CHAT])

    expect(reconciliation['owed'].has(CHAT)).toBe(false)
    expect(reconciliation['firstOpened'].has(CHAT)).toBe(false)
  })
})
