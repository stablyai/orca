import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { createTrackedJournalOpener } from './journal-store-test-open'

// Which rows an older host can still read: only rows that carry a turn item
// are stamped with the version it does not know, and the epoch row never is.
// Read raw: the reader upcasts every row to the current version, so only the
// stored row_json says what an older build would see.
describe('journal row schema versions', () => {
  let root = ''
  const opener = createTrackedJournalOpener()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-row-version-'))
  })
  afterEach(async () => {
    await opener.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('stamps v3 only on rows that carry a turn item', async () => {
    const journal = await opener.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      now: () => 1_000,
      journalDir: join(root, 'session-1')
    })
    const identity = { provider: 'orca' as const, clientMessageId: 'm1' }
    await journal.appendItem(
      identity,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: 'session-1', recordId: 'turn-lifecycle:t1' },
      agentJournalTurnBody({ turnId: 't1', state: 'running', startedAt: 1_000 }),
      { fence: 1 }
    )
    await journal.close()
    const opened = openJournalDatabase(journalDatabaseFile(join(root, 'session-1')))
    try {
      const stored = opened.db
        .prepare('SELECT row_json FROM journal_rows ORDER BY seq')
        .all()
        .map((row) => JSON.parse(String((row as { row_json: string }).row_json)))
        .map((row: { kind: string; v: number }) => [row.kind, row.v])
      expect(stored).toEqual([
        ['epoch', 2],
        ['item', 2],
        ['item', 3]
      ])
    } finally {
      opened.db.close()
    }
  })
})
