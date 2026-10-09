// The startup scan's reconciliation workers over their whole life: what a quit cuts short, what
// they never publish or close, and what ends a retry that cannot succeed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
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
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  openScanHost,
  scanIdle as idle,
  scanRecord as record,
  scanTurnState as turnState,
  seedScanJournal
} from './structured-agent-session-startup-scan.test-fixture'

const CHAT = 'chat-aaaaaaa1'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost | undefined
const warnings: string[] = []

function openHost(options: Parameters<typeof openScanHost>[2] = {}): StructuredAgentSessionHost {
  const logger = createStructuredAgentSessionLogger()
  host = openScanHost(root, store, {
    logger: { ...logger, warn: (message) => warnings.push(message) },
    ...options
  })
  return host
}

async function seed(sessionIds: readonly string[], extra: Parameters<typeof record>[2] = {}) {
  await seedTestAgentSessionRecordStore(root, {
    records: sessionIds.map((id) => record(id, true, extra))
  })
  for (const sessionId of sessionIds) {
    await seedScanJournal(root, sessionId)
  }
  store = await openTestAgentSessionRecordStore(root)
}

/** Counts every journal open from now on. */
function countOpens(): { opens: number } {
  const counter = { opens: 0 }
  const open = AgentSessionJournal.prototype.open
  vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function (
    this: AgentSessionJournal
  ) {
    counter.opens += 1
    return open.call(this)
  })
  return counter
}

beforeEach(async () => {
  warnings.length = 0
  root = await mkdtemp(join(tmpdir(), 'orca-startup-scan-lifetime-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = undefined
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a quit during the startup scan', () => {
  it('waits only for work already started: no chat still waiting for a slot opens or recovers', async () => {
    const chats = Array.from(
      { length: 10 },
      (_, index) => `chat-q${String(index).padStart(7, '0')}`
    )
    await seed(chats)
    const current = openHost()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { runtimeState } = current.collaboratorsForTests()
    const resolve = runtimeState.resolveRecovery.bind(runtimeState)
    let recoveries = 0
    vi.spyOn(runtimeState, 'resolveRecovery').mockImplementation(async (sessionId) => {
      recoveries += 1
      await gate
      return resolve(sessionId)
    })
    await current.reconcileRestartLeases()
    await vi.waitFor(() => expect(recoveries).toBe(4))
    const counter = countOpens()

    const quit = current.flushAllStreamedEvents()
    release()
    await quit
    host = undefined

    // The four already recovering finished that step and went no further; the six still waiting
    // for a slot never started.
    expect(recoveries).toBe(4)
    expect(counter.opens).toBe(0)
  })
})

describe('a chat the startup scan settles', () => {
  it('is published to no status surface unless a reader or the restorer opened it', async () => {
    const visible = 'chat-visible1'
    const hidden = ['chat-hidden01', 'chat-hidden02', 'chat-hidden03']
    await seed([visible, ...hidden])
    const published: string[] = []
    const current = openHost({
      statusSink: {
        publish: (summary) => published.push(summary.sessionId),
        forget: () => undefined
      }
    })
    await current.reconcileRestartLeases()
    await current.restoreReadableSessions([visible])
    await current.startupSettled()
    await idle(current, [visible, ...hidden])

    const snapshots: string[][] = []
    const unsubscribe = current.subscribeStatus({
      id: 'renderer',
      emit: (event: AgentSessionStatusEvent) => {
        if (event.type === 'snapshot') {
          snapshots.push(event.sessions.map((session) => session.sessionId))
        }
      }
    })
    unsubscribe()
    expect(new Set(published)).toEqual(new Set([visible]))
    expect(snapshots.at(-1)).toEqual([visible])
    // Settled all the same.
    expect(current.collaboratorsForTests().sessions.has('chat-hidden01')).toBe(false)
    expect(await turnState(current, 'chat-hidden01')).toBe('unverifiable')
  })

  it('stays open when the restorer opened it while the scan was settling it', async () => {
    await seed([CHAT])
    const current = openHost()
    const { sessions } = current.collaboratorsForTests()
    // The restore lands between the scan's read and its pass.
    let restore: Promise<void> | null = null
    const open = AgentSessionJournal.prototype.open
    vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function (
      this: AgentSessionJournal
    ) {
      await open.call(this)
      restore ??= current.restoreReadableSessions([CHAT])
    })
    await current.reconcileRestartLeases()
    await current.startupSettled()
    await restore
    await idle(current, [CHAT])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sessions.has(CHAT)).toBe(true)
    expect(await turnState(current, CHAT)).toBe('unverifiable')
  })
})

describe('a startup worker whose step cannot succeed', () => {
  it('retires at once on a journal no retry can load, and replays it once', async () => {
    await seed([CHAT])
    // The last row is one no build wrote.
    openTestJournalHostDatabase(root)
      .db.prepare(
        `UPDATE journal_rows SET row_json = '{"garbage":true}' WHERE session_id = ? AND seq = (SELECT MAX(seq) FROM journal_rows WHERE session_id = ?)`
      )
      .run(CHAT, CHAT)
    const counter = countOpens()
    const current = openHost()
    await current.reconcileRestartLeases()
    await current.startupSettled()

    expect(current.collaboratorsForTests().reconciliation.owes(CHAT)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(counter.opens).toBe(1)
    expect(warnings).toContain("a chat's history cannot be loaded, so nothing is settled")
  })

  it('leaves a rewind only its provider can prove for the next acquisition, and retires', async () => {
    const rewind = {
      operationId: 'op-rewind',
      callerKey: 'caller',
      itemId: agentJournalItemKey({
        provider: 'codex',
        threadId: 'thread',
        turnId: 'turn-1',
        ordinal: 0
      }),
      expectedEpoch: 'epoch-x',
      phase: 'prepared' as const,
      retained: []
    }
    await seed([CHAT], { rewind })
    const current = openHost()
    await current.reconcileRestartLeases()
    await current.startupSettled()
    await idle(current, [CHAT])

    expect(store.getRecord(CHAT)?.rewind?.phase).toBe('prepared')
    expect(current.collaboratorsForTests().sessions.has(CHAT)).toBe(false)
    expect(warnings).toEqual(['recovering a rewind an earlier process left did not finish'])
    expect(await turnState(current, CHAT)).toBe('unverifiable')
  })
})
