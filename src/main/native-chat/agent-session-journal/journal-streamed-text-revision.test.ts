import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexImageItemBody } from '../../codex/codex-image-item-translation'
import { journalPragmaNumber } from './journal-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { openAgentSessionJournal } from './journal-store-factory'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-streamed-revision-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const text = (role: 'assistant' | 'user', value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})

it('keeps image and goal transitions FULL, streams text at NORMAL, and restores FULL', async () => {
  const database = openTestJournalHostDatabase(root)
  const levels: number[] = []
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')), true)
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')))
  expect(() =>
    database.transaction(() => {
      throw new Error('rolled back')
    }, true)
  ).toThrow('rolled back')
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  expect(levels).toEqual([1, 2, 2, 2])
  const journal = await openAgentSessionJournal({
    database,
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: null
    }
  })
  levels.length = 0
  const exec = database.db.exec.bind(database.db)
  vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      levels.push(journalPragmaNumber(database.db, 'synchronous'))
    }
    exec(sql)
  })
  const image = { id: 'image', type: 'imageGeneration' }
  for (const body of [
    text('assistant', 'Generating image'),
    codexImageItemBody({ ...image, status: 'inProgress' }),
    codexImageItemBody({ ...image, status: 'completed', result: 'AAAA' }),
    text('assistant', 'Image preview unavailable'),
    { ...text('assistant', 'Goal'), sentAs: 'goal' as const },
    text('assistant', 'Goal reached')
  ]) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
      body,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  expect(levels).toEqual([2, 1, 2, 2, 2, 2])
  expect(journalPragmaNumber(database.db, 'synchronous')).toBe(2)
  await journal.close()
})
