import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  insertTestJournalRow,
  publishTestJournalEpoch,
  deleteTestJournalRow,
  updateTestJournalRowJson
} from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { readAgentSessionHistory } from '../agent-session-history-page'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

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
  const { db } = openTestJournalHostDatabase(root)
  const base = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    fence: 1,
    ts: 1_000
  }
  db.exec('BEGIN IMMEDIATE')
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
  db.exec('COMMIT')
  return journals.open({ identity, stateDirectory: root })
}

describe('forward history SQL read budget', () => {
  it('keeps an exact final page final and preserves unlimited journal readers', async () => {
    const journal = await seedJournal(6)
    const cursor = { epoch: journal.epoch, sequence: 1 }
    expect(journal.readSince(cursor)).toMatchObject({ ok: true, rows: expect.any(Array) })
    const first = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor,
      limit: 3
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    const last = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: first.page.window.nextCursor,
      limit: 3
    })
    expect(last).toMatchObject({ ok: true, page: { hasNewer: false } })
    const unlimited = journal.readSince(cursor)
    expect(unlimited.ok && unlimited.rows).toHaveLength(6)
  })

  it('reports a sequence gap when the next page reaches it', async () => {
    const journal = await seedJournal(6)
    const { db } = openTestJournalHostDatabase(root!)
    deleteTestJournalRow(db, identity.sessionId, 4)
    const first = readAgentSessionHistory(journal, {
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
      readAgentSessionHistory(journal, {
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
      const { db } = openTestJournalHostDatabase(root!)
      updateTestJournalRowJson(db, identity.sessionId, 4, rowJson)
      const page = readAgentSessionHistory(journal, {
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
