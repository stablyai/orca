// After a crash, a settled chat lists with the status the last run saved, without opening its
// history. A chat the crash cut mid-turn shows nothing saved: startup opens it, and the verdict its
// journal's settle writes is the first and only one its row shows.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_LOCATION as LOCATION,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import {
  NEVER_WRITTEN,
  RELAUNCHED_AT,
  crashedRecord,
  lastStatusPath,
  savedEntry,
  seedRunningTurn,
  startStatusStore,
  writeLastStatus
} from './structured-agent-session-saved-status-startup.test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let statusStore: Awaited<ReturnType<typeof startStatusStore>>

/** The relaunched app: the status store loads the file, then the host comes up over it. */
async function relaunch(
  saved: Record<string, unknown>,
  probe: AgentSessionOwnerProbe = { outcome: 'pid-absent' }
): Promise<{ onSessionStatusChanged: ReturnType<typeof vi.fn> }> {
  writeLastStatus(root, saved)
  statusStore = await startStatusStore(root)
  const onSessionStatusChanged = vi.fn()
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    probeOwner: async () => probe,
    now: () => RELAUNCHED_AT,
    statusSink: statusStore.sink,
    onSessionStatusChanged
  })
  return { onSessionStatusChanged }
}

/** What startup does: the lease check, then saved statuses, then the tab list. */
async function startUp(listed: string[] = [SESSION]): Promise<void> {
  await host.reconcileRestartLeases()
  await host.restoreSavedStatuses(listed)
}

async function turnState(): Promise<string | undefined> {
  return (await host.journalSnapshot(SESSION)).items
    .map((item) => readAgentJournalTurn(item.body))
    .find(Boolean)?.state
}

const savedIds = () =>
  statusStore.server.readSavedStructuredStatuses().map((entry) => entry.sessionId)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-saved-status-startup-'))
  await seedTestAgentSessionRecordStore(root, {
    records: [crashedRecord(), crashedRecord(NEVER_WRITTEN)]
  })
  store = await openTestAgentSessionRecordStore(root)
  await seedRunningTurn(root)
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  statusStore?.server.stop()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('a chat a crash cut mid-turn', () => {
  it.each(['working', 'attention'] as const)(
    'saved %s days ago, is settled at startup and shows only the verdict its settle wrote',
    async (status) => {
      await relaunch({ [SESSION]: savedEntry(status) })

      await startUp()

      expect(await turnState()).toBe('interrupted')
      const rows = statusStore.rowsFor(SESSION)
      expect(rows.length).toBeGreaterThan(0)
      // Every row is the open's own: none carries what was saved, or any other verdict.
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'idle',
          turnOutcome: 'interruption',
          latestPrompt: 'run the loop'
        })
      }
      expect(statusStore.server.readSavedStructuredStatuses()).toEqual([
        { sessionId: SESSION, saved: { summary: expect.objectContaining({ status: 'idle' }) } }
      ])
    }
  )

  it("reads Couldn't confirm when its agent may still be running, as its open writes", async () => {
    // An owner proven alive that this platform does not stop: released with no proof of death.
    await relaunch(
      { [SESSION]: savedEntry('working') },
      { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
    )
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    await startUp()

    expect(await turnState()).toBe('unverifiable')
    expect(statusStore.rowsFor(SESSION).at(-1)).toMatchObject({
      status: 'idle',
      turnOutcome: 'unconfirmed'
    })
  })

  it('is settled, closed and forgotten when no tab lists it', async () => {
    await relaunch({ [SESSION]: savedEntry('working') })

    await startUp([])

    expect(host.hasSession(SESSION)).toBe(false)
    expect(savedIds()).toEqual([])
    expect(await turnState()).toBe('interrupted')
  })

  it('still lists, with no status shown, when its history cannot open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    updateTestJournalRowJson(openTestJournalHostDatabase(root).db, SESSION, 1, '}{')
    await relaunch({ [SESSION]: savedEntry('working') })

    await expect(startUp()).resolves.toBeUndefined()

    expect(host.hasSession(SESSION)).toBe(false)
    expect(statusStore.rowsFor(SESSION)).toEqual([])
    expect(host.listSessionTabs([SESSION])).toEqual([
      { sessionId: SESSION, workspaceId: LOCATION.workspaceId, agent: 'claude' }
    ])
  })
})

describe('a chat that was settled at the restart', () => {
  const idle = savedEntry('idle', { turnOutcome: 'success', lastAssistantMessage: 'Shipped' })

  it('saved days ago, lists with that status, opens nothing and re-drives nothing', async () => {
    const { onSessionStatusChanged } = await relaunch({ [SESSION]: idle })
    const status: unknown[] = []
    host.subscribeStatus({ id: 'list', emit: (event) => status.push(event) })

    await startUp()

    expect(host.hasSession(SESSION)).toBe(false)
    // The journal's half as saved; the record's half from the record.
    const restored = {
      ...idle.summary,
      workspaceId: LOCATION.workspaceId,
      agent: 'claude',
      conversationName: 'Named on the record'
    }
    expect(statusStore.rowsFor(SESSION)).toEqual([expect.objectContaining(restored)])
    expect(status).toContainEqual({ type: 'status', session: expect.objectContaining(restored) })
    // Mail, naming and first-turn renames listen here; a saved status is not a journal edge.
    expect(onSessionStatusChanged).not.toHaveBeenCalled()
  })

  it('writes nothing at startup: restoring a saved status is not a new one', async () => {
    await relaunch({ [SESSION]: idle })
    const before = readFileSync(lastStatusPath(root), 'utf8')

    await startUp()

    expect(readFileSync(lastStatusPath(root), 'utf8')).toBe(before)
  })

  it('keeps the live status of a chat something opened before startup restored it', async () => {
    await relaunch({ [SESSION]: idle })
    await host.journalSnapshot(SESSION)
    // What startup read before that open saved over it.
    statusStore.sink.readSavedStatuses = () => [{ sessionId: SESSION, saved: idle }]

    await startUp()

    expect(host.readStatusSummary(SESSION)).toMatchObject({ latestPrompt: 'run the loop' })
  })

  it('gives a chat with no history no tab and no row, and lets its saved status die', async () => {
    await relaunch({ [NEVER_WRITTEN]: savedEntry('idle', {}, NEVER_WRITTEN) })

    await startUp([SESSION, NEVER_WRITTEN])

    expect(host.listSessionTabs([SESSION, NEVER_WRITTEN, SESSION])).toEqual([
      { sessionId: SESSION, workspaceId: LOCATION.workspaceId, agent: 'claude' }
    ])
    expect(statusStore.rowsFor(NEVER_WRITTEN)).toEqual([])
    expect(savedIds()).toEqual([])
  })

  it('is replaced by its own publish once something opens it', async () => {
    await relaunch({ [SESSION]: idle })
    await startUp()

    await host.journalSnapshot(SESSION)

    expect(host.readStatusSummary(SESSION)).toMatchObject({ latestPrompt: 'run the loop' })
    expect(statusStore.rowsFor(SESSION).at(-1)).toMatchObject({ latestPrompt: 'run the loop' })
  })
})
