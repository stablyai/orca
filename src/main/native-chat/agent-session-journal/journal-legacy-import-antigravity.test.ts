import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { importLegacyTranscriptIntoJournal } from './journal-legacy-import'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'

it('imports the Antigravity decoder into the durable journal without inventing turn completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-agy-journal-'))
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: 'conversation',
      workspaceId: 'folder:workspace',
      hostId: 'host',
      agent: 'antigravity',
      providerHandle: { kind: 'opaque', agent: 'antigravity', value: 'conversation' }
    },
    database: openTestJournalHostDatabase(root)
  })
  try {
    const filePath = join(__dirname, '../__fixtures__/antigravity/tool-turn.jsonl')
    const input = {
      journal,
      agent: 'antigravity' as const,
      sessionId: 'conversation',
      fence: 1,
      options: { filePath }
    }
    expect((await importLegacyTranscriptIntoJournal(input)).ok).toBe(true)
    const first = journal.snapshot().items
    expect(first.some((item) => item.body.kind === 'tool-call')).toBe(true)
    expect(
      first.some((item) => item.body.kind === 'tool-call' && item.body.name === 'tool-result')
    ).toBe(true)
    expect(first.some((item) => item.body.kind === 'turn')).toBe(false)
    expect(first.some((item) => item.body.kind === 'message' && item.body.role === 'user')).toBe(
      true
    )
    expect((await importLegacyTranscriptIntoJournal(input)).ok).toBe(true)
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(
      first.map((item) => item.itemId)
    )
  } finally {
    await journal.close()
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
