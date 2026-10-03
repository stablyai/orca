// A restored chat whose open fails keeps its tab, so a phone on a headless host still lists it and
// its read says why, instead of the chat disappearing: damaged, or saved by a newer Orca.

import { cp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const relaunchedRoots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

/** A restarted process over the chat's files, its epoch row rewritten by `edit`. */
async function relaunchWith(
  edit: (db: Database.Database) => void
): Promise<StructuredAgentSessionHost> {
  const before = hostTestState()
  await attach()
  await before.host.flushStreamedEvents(SESSION)
  await before.store.renewLeases([])
  const relaunched = `${before.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(before.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  edit(openTestJournalHostDatabase(relaunched).db)
  const store = await openTestAgentSessionRecordStore(relaunched)
  const host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  return host
}

const damaged = (db: Database.Database) => updateTestJournalRowJson(db, SESSION, 1, '}{')
const savedByNewerOrca = (db: Database.Database) => {
  const epochRow = liveTestJournalRows(db, SESSION).find((row) => row.seq === 1)!
  const newer = { ...JSON.parse(epochRow.rowJson), v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1 }
  updateTestJournalRowJson(db, SESSION, 1, JSON.stringify(newer))
}

it.each([
  ['damaged', damaged, 'journalCorrupt'],
  ['saved by a newer Orca', savedByNewerOrca, 'journalWrittenByNewerOrca']
] as const)(
  'lists a restored chat that could not be opened (%s), and its read and send are refused with why',
  async (_why, edit, reason) => {
    const host = await relaunchWith(edit)
    const workspaceId = hostTestState().store.getRecord(SESSION)?.location.workspaceId
    const refusal = { code: 'agent_session_journal_unreadable', details: { reason } }

    await host.restoreReadableSessions([SESSION])

    expect(host.hasSession(SESSION)).toBe(false)
    expect(host.listSessionTabs()).toEqual([
      { sessionId: SESSION, workspaceId, agent: expect.any(String) }
    ])
    // Every read is refused with why, and the host logs it once for the chat.
    for (let read = 0; read < 3; read += 1) {
      await expect(host.history({ sessionId: SESSION, direction: 'tail' })).rejects.toMatchObject({
        refusal
      })
    }
    const readFailureLogs = vi
      .mocked(console.warn)
      .mock.calls.filter(([line]) => String(line).includes('open-for-read'))
    expect(readFailureLogs).toHaveLength(1)
    const body = hostTestMessage('sent to a chat that cannot load')
    await expect(
      host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).resolves.toMatchObject({ ok: false, refusal })

    await host.setSessionTabVisibility(SESSION, false)
    expect(host.listSessionTabs()).toEqual([])
    await host.flushAllStreamedEvents()
  }
)
