// The one-time copy of `agent-sessions.json` into the chat journal database: what it copies, what it
// leaves untouched, and how each fence stays clear of anything the file's writers could have granted.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { journalPragmaNumber } from '../native-chat/agent-session-journal/journal-database'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { legacyAgentSessionStorePath } from './agent-session-record-store-file'
import { openStructuredAgentSessionJournalDatabase } from './structured-agent-session-journal-open'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

const NOW = 1_800_000_000_000
const ALPHA = 'session-alpha'
const BETA = 'session-beta'
const OPERATION_ID = `${NOW}-000000000000000000000000000000aa`
const LEGACY_TAB_ID = `structured-agent-session-${ALPHA}`

let root: string
const opened: JournalHostDatabase[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-record-import-'))
})

afterEach(async () => {
  opened.splice(0).forEach((database) => database.close())
  await rm(root, { recursive: true, force: true })
})

const legacyPath = (): string => legacyAgentSessionStorePath(root)

/** A released chat: no owner a restart probe must look for. */
function record(sessionId: string, lease: Partial<AgentSessionLease> = {}): AgentSessionRecord {
  return agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      runtimeFence: 2,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released',
      ...lease
    })
  )
}

const OPERATION: AgentSessionOperationRow = {
  callerKey: 'client-1',
  operationId: OPERATION_ID,
  fingerprint: 'fp-1',
  operationTimestamp: NOW,
  recordedAt: NOW,
  expiresAt: NOW + 60_000,
  outcome: { status: 'succeeded', sessionId: ALPHA }
}

function legacyFile(
  records: readonly (Record<string, unknown> & { sessionId: string })[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    hostId: 'local',
    records: Object.fromEntries(records.map((value) => [value.sessionId, value])),
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {},
    ...extra
  }
}

async function writeLegacy(file: unknown, backup?: unknown): Promise<void> {
  await mkdir(dirname(legacyPath()), { recursive: true })
  await writeFile(legacyPath(), typeof file === 'string' ? file : JSON.stringify(file))
  if (backup !== undefined) {
    await writeFile(
      `${legacyPath()}.bak`,
      typeof backup === 'string' ? backup : JSON.stringify(backup)
    )
  }
}

/** What an install does: open the database, running the copy if it is owed, then the store. */
async function install(): Promise<{
  database: JournalHostDatabase
  store: AgentSessionRecordStore
  reports: unknown[]
}> {
  const log = recordingStructuredAgentSessionLogger()
  const database = await openStructuredAgentSessionJournalDatabase({
    logger: log.logger,
    stateDirectory: root,
    hostId: 'local'
  })
  opened.push(database)
  // Each report reaches the log as one entry under its scope, its kind as the outcome.
  const reports = log.entries
    .filter((entry) => entry.fields.scope === 'legacy-record-import')
    .map(({ fields: { scope: _scope, outcome, ...rest } }) => ({ kind: outcome, ...rest }))
  return {
    database,
    store: AgentSessionRecordStore.open({ journalDatabase: database, hostId: 'local' }),
    reports
  }
}

function unreconciled(value: AgentSessionRecord): AgentSessionRecord {
  return { ...value, lease: { ...value.lease, unreconciled: true } }
}

describe('copying the records file into the chat database', () => {
  it('copies every record, operation, key and tab, and leaves both files byte-identical', async () => {
    const alpha = record(ALPHA)
    const beta = record(BETA, { runtimeFence: 5 })
    const file = legacyFile([alpha, beta], {
      operations: { [agentSessionOperationKey('client-1', OPERATION_ID)]: OPERATION },
      retiredClaimKeys: [{ keyId: 'key-0', retiredAt: NOW }],
      sessionTabs: [{ tabId: 'tab-beta', sessionId: BETA }]
    })
    await writeLegacy(file, file)
    const [primary, backup] = await Promise.all([
      readFile(legacyPath()),
      readFile(`${legacyPath()}.bak`)
    ])

    const { database, store, reports } = await install()

    expect(reports).toEqual([])
    expect(journalPragmaNumber(database.db, 'user_version')).toBe(4)
    expect(store.getRecord(ALPHA)).toEqual(unreconciled(alpha))
    expect(store.getRecord(BETA)).toEqual(unreconciled(beta))
    expect(store.listOperationRows()).toEqual([OPERATION])
    expect(store.isClaimKeyVerifiable('key-0', NOW)).toBe(true)
    expect(store.getVisibleSessionTabIndex()).toEqual({ present: true, sessionIds: [BETA] })
    expect(store.getSessionTabId(BETA)).toBe('tab-beta')
    expect(await readFile(legacyPath())).toEqual(primary)
    expect(await readFile(`${legacyPath()}.bak`)).toEqual(backup)
  })

  it('copies once: a later launch never reads the file again', async () => {
    await writeLegacy(legacyFile([record(ALPHA)]))
    const first = await install()
    await first.store.setConversationName(ALPHA, 'kept')
    first.database.close()
    // A downgraded build changed its own file; the database keeps what it holds.
    await writeLegacy(legacyFile([record(BETA)]))

    const { store } = await install()

    expect(store.getRecord(ALPHA)?.conversationName).toBe('kept')
    expect(store.getRecord(BETA)).toBeNull()
  })

  it('reports a file no read will make usable, copies nothing, and leaves it untouched', async () => {
    const adHoc = JSON.stringify({ ...legacyFile([record(ALPHA)]), schemaVersion: 1 })
    await writeLegacy(adHoc)

    const { database, store, reports } = await install()

    expect(reports).toEqual([
      {
        kind: 'unusable',
        error: expect.objectContaining({ message: 'agent_session_store_corrupt' })
      }
    ])
    expect(journalPragmaNumber(database.db, 'user_version')).toBe(4)
    expect(store.listRecords()).toEqual([])
    expect(await readFile(legacyPath(), 'utf-8')).toBe(adHoc)
  })

  it('reports a file from another host id and copies it, so its owners stay unresolved', async () => {
    await writeLegacy({ ...legacyFile([record(ALPHA)]), hostId: 'ssh:elsewhere' })

    const { store, reports } = await install()

    expect(reports).toEqual([
      { kind: 'host-mismatch', fileHostId: 'ssh:elsewhere', hostId: 'local' }
    ])
    expect(store.hostId).toBe('local')
    expect(store.getRecord(ALPHA)).not.toBeNull()
  })

  it('maps a lease the removed terminal handoff wrote, and stores it mapped', async () => {
    const legacy = {
      ...record(ALPHA, {
        ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-a' }
      }),
      lease: {
        ...record(ALPHA).lease,
        ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-a' },
        claimStatus: 'live',
        runtimeKind: 'tui',
        handoffStage: 'old-owner-stopped',
        handoffOperationId: 'op-handoff',
        processlessAt: 5
      }
    }
    await writeLegacy(legacyFile([legacy]))

    const { database, store } = await install()

    expect(store.isSessionUnreadable(ALPHA)).toBe(false)
    const lease = store.getRecord(ALPHA)?.lease
    expect(lease).toMatchObject({
      runtimeKind: 'native',
      handoffStage: 'recovering',
      handoffOperationId: 'op-handoff',
      claimStatus: 'conflicted'
    })
    expect(lease).not.toHaveProperty('processlessAt')
    const stored = database.db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
      .get(ALPHA)
    expect(JSON.parse(String(stored?.record_json)).lease).toMatchObject({
      runtimeKind: 'native',
      handoffStage: 'recovering'
    })
    expect(JSON.parse(String(stored?.record_json)).lease).not.toHaveProperty('processlessAt')
  })
})

describe('a record the file set aside', () => {
  it('copies a record this build cannot read verbatim, and never grants it', async () => {
    const unsupported = { ...record(ALPHA), schemaVersion: 1 }
    await writeLegacy(legacyFile([unsupported]))

    const { database, store } = await install()

    expect(store.getRecord(ALPHA)).toBeNull()
    expect(store.isSessionUnreadable(ALPHA)).toBe(true)
    await expect(store.setConversationName(ALPHA, 'x')).rejects.toThrow(
      'execution_owner_reconciling'
    )
    const stored = database.db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
      .get(ALPHA)
    expect(JSON.parse(String(stored?.record_json))).toEqual(unsupported)
  })

  // #23589: both copies exist only when an older build recovered the readable one from its backup,
  // so the set-aside copy may already have granted fences the readable one cannot show.
  it('keeps the readable copy and raises its floor above both: 8, never 3, never 7 twice', async () => {
    const readable = record(ALPHA, { runtimeFence: 2 })
    const setAside = { ...record(ALPHA, { runtimeFence: 7 }), schemaVersion: 99 }
    await writeLegacy(
      legacyFile([readable], {
        unusableRecords: { [ALPHA]: { reason: 'unsupported_schema', raw: setAside } }
      })
    )

    const { store } = await install()

    const lease = store.getRecord(ALPHA)?.lease
    expect(lease?.runtimeFence).toBe(2)
    expect(lease?.minimumNextFence).toBe(8)
    expect(nextAgentSessionFence(lease!)).toBe(8)
  })

  it('takes a record the primary set aside from the backup, with its floor raised', async () => {
    const readable = record(ALPHA, { runtimeFence: 3 })
    await writeLegacy(
      legacyFile([], {
        unusableRecords: { [ALPHA]: { reason: 'unsupported_schema', raw: { schemaVersion: 99 } } }
      }),
      legacyFile([readable])
    )

    const { store } = await install()

    // The commit the backup lost may have granted 4, so the next grant clears it.
    expect(store.getRecord(ALPHA)?.lease.minimumNextFence).toBe(5)
  })
})

describe('a primary the backup stands in for', () => {
  it('copies the backup with every floor raised past what the lost commit could have granted', async () => {
    await writeLegacy('{ truncated', legacyFile([record(ALPHA, { runtimeFence: 1 })]))

    const { store, reports } = await install()

    expect(reports).toEqual([])
    expect(store.getRecord(ALPHA)?.lease).toMatchObject({ runtimeFence: 1, minimumNextFence: 3 })
    expect(await readFile(legacyPath(), 'utf-8')).toBe('{ truncated')
  })

  it('reports both copies unusable and copies nothing', async () => {
    await writeLegacy('{ truncated', '{ also truncated')

    const { store, reports } = await install()

    expect(reports).toMatchObject([{ kind: 'unusable' }])
    expect(store.listRecords()).toEqual([])
  })

  // A read that can clear says nothing about the backup's contents, so the copy stays owed.
  it('keeps the copy owed when the backup cannot be read behind a torn primary', async () => {
    await writeLegacy('{ truncated')
    await mkdir(`${legacyPath()}.bak`)

    const { database, store, reports } = await install()

    expect(reports).toMatchObject([{ kind: 'unavailable' }])
    expect(journalPragmaNumber(database.db, 'user_version')).toBe(3)
    expect(store.listRecords()).toEqual([])
  })

  // Falling back would replace the primary's newer state with the backup's older one for good.
  it('never takes a valid backup when the primary cannot be read', async () => {
    await mkdir(legacyPath(), { recursive: true })
    await writeFile(`${legacyPath()}.bak`, JSON.stringify(legacyFile([record(ALPHA)])))

    const { database, store, reports } = await install()

    expect(reports).toMatchObject([{ kind: 'unavailable' }])
    expect(journalPragmaNumber(database.db, 'user_version')).toBe(3)
    expect(store.listRecords()).toEqual([])
  })
})

describe('the tab index from before the table', () => {
  it('seeds the table from the visible list, keeping each chat on the id it has today', async () => {
    const gamma = 'session-gamma'
    await writeLegacy(
      legacyFile(
        [
          { ...record(ALPHA), surfaceTabId: 'tab-alpha' },
          { ...record(BETA), surfaceTabId: `structured-agent-session-${BETA}` },
          record(gamma)
        ],
        { visibleSessionIds: [ALPHA, BETA] }
      )
    )

    const { store } = await install()

    expect(store.getSessionTabId(ALPHA)).toBe('tab-alpha')
    expect(store.getSessionTabId(BETA)).toBe(`structured-agent-session-${BETA}`)
    expect(store.getSessionTabId(gamma)).toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([ALPHA, BETA])
  })

  it('seeds a chat cleared before the upgrade under the id its tab opened with', async () => {
    const cleared = (replacementSessionId: string) => ({
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      operationId: OPERATION_ID,
      callerKey: 'client-1',
      replacementSessionId
    })
    await writeLegacy(
      legacyFile(
        [
          { ...record(ALPHA), conversationCommand: cleared('clear-one') },
          { ...record('clear-one'), conversationCommand: cleared('clear-two') },
          { ...record('clear-two'), surfaceTabId: 'structured-agent-session-clear-two' }
        ],
        { visibleSessionIds: [ALPHA, 'clear-two'] }
      )
    )

    const { store } = await install()

    expect(store.getSessionTabId('clear-two')).toBe(LEGACY_TAB_ID)
    const reopenedTab = store.getSessionTabId(ALPHA)
    expect(reopenedTab).not.toBe(LEGACY_TAB_ID)
    expect(reopenedTab).not.toContain(':')
    expect(store.listVisibleSessionIds()).toEqual([ALPHA, 'clear-two'])
  })

  it('leaves the index unrecorded when only a chat created while the copy was owed recorded one', async () => {
    await mkdir(legacyPath(), { recursive: true })
    const owed = await install()
    owed.database.db
      .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
      .run(BETA, JSON.stringify(record(BETA)))
    await AgentSessionRecordStore.open({
      journalDatabase: owed.database,
      hostId: 'local'
    }).setSessionTabVisibility(BETA, true)
    owed.database.close()
    await rm(legacyPath(), { recursive: true })
    await writeLegacy(legacyFile([record(ALPHA)]))

    const { database, store } = await install()

    expect(journalPragmaNumber(database.db, 'user_version')).toBe(4)
    expect(store.listRecords().map(({ sessionId }) => sessionId)).toEqual([BETA, ALPHA])
    // Restore then takes the profile's tabs, beside the tab the owed-era chat left.
    expect(store.getVisibleSessionTabIndex()).toEqual({ present: false, sessionIds: [BETA] })
  })

  it('reads a recorded table, never the record field', async () => {
    await writeLegacy(
      legacyFile([{ ...record(ALPHA), surfaceTabId: 'tab-stale' }], {
        sessionTabs: [{ tabId: 'tab-alpha', sessionId: ALPHA }]
      })
    )

    expect((await install()).store.getSessionTabId(ALPHA)).toBe('tab-alpha')
  })

  it('keeps a record whose legacy tab id is malformed, seeding it under the derived id', async () => {
    await writeLegacy(
      legacyFile([{ ...record(ALPHA), surfaceTabId: `agent-session:${ALPHA}` }], {
        visibleSessionIds: [ALPHA]
      })
    )

    const { store } = await install()

    expect(store.isSessionUnreadable(ALPHA)).toBe(false)
    expect(store.getSessionTabId(ALPHA)).toBe(LEGACY_TAB_ID)
  })

  it('treats a malformed table as an unusable file rather than guessing', async () => {
    await writeLegacy(
      legacyFile([record(ALPHA)], {
        sessionTabs: [
          { tabId: 'tab-alpha', sessionId: ALPHA },
          { tabId: 'tab-alpha', sessionId: BETA }
        ]
      })
    )

    const { store, reports } = await install()

    expect(reports).toMatchObject([{ kind: 'unusable' }])
    expect(store.listRecords()).toEqual([])
    expect(store.getVisibleSessionTabIndex().present).toBe(false)
  })
})
