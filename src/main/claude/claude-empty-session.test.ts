import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { openJournalDatabase } from '../native-chat/agent-session-journal/journal-database'
import {
  journalDatabaseFile,
  journalDirectoryFor
} from '../native-chat/agent-session-journal/journal-paths'
import { canStartEmptyClaudeSession } from './claude-empty-session'

const providerId = 'baaf7eb0-7d46-4915-84f7-32bfd2964c82'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-empty-claude-'))
  roots.push(root)
  const record = {
    sessionId: 'orca-session',
    provider: 'claude',
    location: { workspaceId: 'workspace', workspaceKind: 'folder' },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'account') },
    providerHandleChain: [
      { origin: 'created', handle: { provider: 'claude', sessionId: providerId, leafUuid: null } }
    ]
  } as AgentSessionRecord
  await mkdir(record.accountHome.path)
  const directory = journalDirectoryFor(root, {
    workspaceId: 'workspace',
    sessionId: record.sessionId
  })
  await mkdir(directory, { recursive: true })
  const path = journalDatabaseFile(directory)
  const { db } = openJournalDatabase(path)
  const initial = {
    kind: 'epoch',
    v: 2,
    reason: 'session_created',
    epoch: 'epoch',
    seq: 1,
    fence: 0,
    ts: 1,
    providerHandle: { kind: 'claude', sessionId: providerId, leafUuid: null }
  }
  db.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
    record.sessionId,
    'epoch',
    1,
    1,
    JSON.stringify(initial)
  )
  db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(record.sessionId, 'epoch', 1)
  db.close()
  return { root, record, path, initial }
}

describe('empty Claude session proof', () => {
  it('accepts a never-used session, but not a transcript even if it is empty or corrupt', async () => {
    const { root, record } = await fixture()
    expect(await canStartEmptyClaudeSession(record, root)).toBe(true)
    const project = join(record.accountHome.path, 'projects', 'workspace')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${providerId}.jsonl`), '')
    expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
  })

  it('never replaces missing history after a submission, repair, or epoch replacement', async () => {
    const { root, record, path, initial } = await fixture()
    const { db } = openJournalDatabase(path)
    try {
      db.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
        record.sessionId,
        'epoch',
        2,
        2,
        JSON.stringify({ kind: 'submission', clientMessageId: 'sent' })
      )
      expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
      db.prepare('DELETE FROM journal_rows WHERE seq=2').run()
      db.prepare('INSERT INTO journal_repairs VALUES (?, ?, ?, ?)').run(
        record.sessionId,
        'epoch',
        1,
        2
      )
      expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
      db.prepare('DELETE FROM journal_repairs').run()
      db.prepare('UPDATE journal_rows SET row_json=?').run(
        JSON.stringify({ ...initial, reason: 'provider_resumed' })
      )
      expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('refuses adopted sessions, known transcript leaves, and unavailable account or journal data', async () => {
    const { root, record, path } = await fixture()
    record.providerHandleChain[0].origin = 'adopted'
    expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
    record.providerHandleChain[0].origin = 'created'
    const handle = record.providerHandleChain[0].handle
    if (handle.provider !== 'claude') {
      throw new Error('expected Claude')
    }
    handle.leafUuid = 'existing-leaf'
    expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
    handle.leafUuid = null
    const home = record.accountHome.path
    record.accountHome.path = join(root, 'missing-account')
    expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
    record.accountHome.path = home
    await rm(path)
    expect(await canStartEmptyClaudeSession(record, root)).toBe(false)
  })
})
