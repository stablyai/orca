import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { observeNativeJournalSql } from '../agent-session-journal/journal-native-test-instrumentation'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import * as rowSchema from '../agent-session-journal/journal-row-schema'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  insertTestJournalRow,
  publishTestJournalEpoch,
  deleteTestJournalRow,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { readAgentSessionHistory } from './agent-session-history-page'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'bounded-catch-up',
  workspaceId: 'folder-workspace',
  hostId: 'remote-host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const journals = createTrackedJournalOpener()
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function seedJournal(count: number) {
  root = await mkdtemp(join(tmpdir(), 'orca-history-read-budget-'))
  const database = await openTestJournalHostDatabase(root)
  const base = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    fence: 1,
    ts: 1_000
  }
  await database.transaction((db) => {
    publishTestJournalEpoch(db, identity.sessionId, base.epoch)
    insertTestJournalRow(db, identity.sessionId, {
      ...base,
      kind: 'epoch',
      seq: 1,
      reason: 'session_created',
      providerHandle: agentSessionJournalProviderHandle(identity)
    })
    for (let index = 0; index < count; index += 1) {
      insertTestJournalRow(db, identity.sessionId, {
        ...base,
        kind: 'item',
        seq: index + 2,
        itemId: `item-${index}`,
        revision: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `${index}:${'x'.repeat(4096)}` }]
        }
      })
    }
  })
  return journals.open({ identity, stateDirectory: root })
}

function observeForwardReads(database: JournalHostDatabase) {
  const returnedRows: number[] = []
  onTestFinished(
    observeNativeJournalSql(database, (entry) => {
      if (!entry.sql.includes('seq > ?')) {
        return
      }
      if (entry.method === 'all') {
        returnedRows.push(entry.rows)
      } else if (entry.method === 'iterate') {
        returnedRows.push(0)
      } else if (entry.method === 'row') {
        returnedRows[returnedRows.length - 1] += entry.rows
      }
    })
  )
  const parse = vi.spyOn(rowSchema, 'parseJournalRow')
  return { returnedRows, parse }
}

describe('forward history SQL read budget', () => {
  it.each([200, 2_000, 20_000])('bounds reconnect reads after %i missed rows', async (count) => {
    const journal = await seedJournal(count)
    const { returnedRows, parse } = observeForwardReads(await openTestJournalHostDatabase(root!))
    const events: AgentSessionSubscribeEvent[] = []
    let delivered = () => {}
    const ready = new Promise<void>((resolve) => {
      delivered = resolve
    })
    new AgentSessionSubscribers().open({
      id: 'reader',
      sessionId: identity.sessionId,
      journal,
      fence: 1,
      cursor: { epoch: journal.epoch, sequence: 1 },
      emit: (event) => {
        events.push(event)
        delivered()
      }
    })
    await ready
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.type).toBe(count > 200 ? 'snapshot' : 'batch')
    const items =
      event.type === 'snapshot' ? event.page.items : event.type === 'batch' ? event.batch.items : []
    expect(items.map((item) => item.itemId)).toEqual(
      Array.from({ length: 200 }, (_, index) => `item-${count - 200 + index}`)
    )
    expect(returnedRows).toEqual([Math.min(count, 201)])
    expect(parse).toHaveBeenCalledTimes(Math.min(count, 201))
  })

  it('keeps an exact final page final and preserves unlimited journal readers', async () => {
    const journal = await seedJournal(6)
    const cursor = { epoch: journal.epoch, sequence: 1 }
    expect(await journal.readSince(cursor)).toMatchObject({ ok: true, rows: expect.any(Array) })
    const first = await readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor,
      limit: 3
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    const last = await readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: first.page.window.nextCursor,
      limit: 3
    })
    expect(last).toMatchObject({ ok: true, page: { hasNewer: false } })
    const unlimited = await journal.readSince(cursor)
    expect(unlimited.ok && unlimited.rows).toHaveLength(6)
  })

  it('reports a sequence gap when the next page reaches it', async () => {
    const journal = await seedJournal(6)
    const database = await openTestJournalHostDatabase(root!)
    await deleteTestJournalRow(database, identity.sessionId, 4)
    const first = await readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: { epoch: journal.epoch, sequence: 1 },
      limit: 2
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    expect(
      await readAgentSessionHistory(journal, {
        sessionId: identity.sessionId,
        direction: 'after',
        cursor: first.page.window.nextCursor,
        limit: 2
      })
    ).toMatchObject({ ok: false, reset: 'journal_gap' })
  })

  it.each(['{', '{"v":9999}'])(
    'preserves parse-stop behavior at lookahead: %s',
    async (rowJson) => {
      const journal = await seedJournal(6)
      const database = await openTestJournalHostDatabase(root!)
      await updateTestJournalRowJson(database, identity.sessionId, 4, rowJson)
      const page = await readAgentSessionHistory(journal, {
        sessionId: identity.sessionId,
        direction: 'after',
        cursor: { epoch: journal.epoch, sequence: 1 },
        limit: 2
      })
      expect(page).toMatchObject({
        ok: true,
        page: { hasNewer: false, window: { nextCursor: { sequence: 3 } } }
      })
      if (!page.ok) {
        throw new Error('Expected valid prefix')
      }
      expect(page.page.items.map((item) => item.itemId)).toEqual(['item-0', 'item-1'])
    }
  )
})
