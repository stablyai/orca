import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { canStartEmptyClaudeSession } from './claude-empty-session'

const providerId = 'baaf7eb0-7d46-4915-84f7-32bfd2964c82'
const roots: string[] = []
afterEach(async () => {
  closeTestJournalHostDatabases()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-empty-claude-'))
  roots.push(root)
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    sessionId: 'orca-session',
    provider: 'claude',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'account') },
    providerHandleChain: [
      {
        linkId: 'link',
        mintedAtFence: 1,
        observedAt: 1,
        origin: 'created',
        handle: { provider: 'claude', sessionId: providerId, leafUuid: null }
      }
    ]
  }
  await mkdir(record.accountHome.path)
  const database = openTestJournalHostDatabase(root)
  const db = database.db
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
  db.prepare('INSERT INTO journal_sessions (session_id, workspace_id, epoch) VALUES (?, ?, ?)').run(
    record.sessionId,
    'workspace',
    'epoch'
  )
  return { root, record, database, initial }
}

describe('empty Claude session proof', () => {
  it('allows the queued first send, but never a send already handed to the provider', async () => {
    const { record, database, initial } = await fixture()
    const submission = {
      v: 2,
      kind: 'submission',
      epoch: 'epoch',
      seq: 2,
      fence: 1,
      ts: 2,
      clientMessageId: 'first',
      payloadFingerprint: 'fp-first',
      providerHandle: initial.providerHandle,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hello' }] },
      handoverRecorded: true
    }
    database.db
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
      .run(record.sessionId, 'epoch', 2, 2, JSON.stringify(submission))
    expect(await canStartEmptyClaudeSession(record, database)).toBe(true)
    database.db
      .prepare('UPDATE journal_rows SET row_json=? WHERE seq=2')
      .run(JSON.stringify({ ...submission, handoverRecorded: undefined }))
    expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
  })

  it('accepts a never-used session, but not a transcript even if it is empty or corrupt', async () => {
    const { record, database } = await fixture()
    expect(await canStartEmptyClaudeSession(record, database)).toBe(true)
    const project = join(record.accountHome.path, 'projects', 'workspace')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${providerId}.jsonl`), '')
    expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
  })

  it('never replaces missing history after a submission, repair, or epoch replacement', async () => {
    const { record, database, initial } = await fixture()
    const db = database.db
    try {
      db.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
        record.sessionId,
        'epoch',
        2,
        2,
        JSON.stringify({ kind: 'submission', clientMessageId: 'sent' })
      )
      expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
      db.prepare('DELETE FROM journal_rows WHERE seq=2').run()
      db.prepare('INSERT INTO journal_repairs VALUES (?, ?, ?, ?)').run(
        record.sessionId,
        'epoch',
        1,
        2
      )
      expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
      db.prepare('DELETE FROM journal_repairs').run()
      db.prepare('UPDATE journal_rows SET row_json=?').run(
        JSON.stringify({ ...initial, reason: 'provider_resumed' })
      )
      expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
    } finally {
      database.close()
    }
  })

  it('refuses adopted sessions, known transcript leaves, and unavailable account or journal data', async () => {
    const { root, record, database } = await fixture()
    record.providerHandleChain[0].origin = 'adopted'
    expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
    record.providerHandleChain[0].origin = 'created'
    const handle = record.providerHandleChain[0].handle
    if (handle.provider !== 'claude') {
      throw new Error('expected Claude')
    }
    handle.leafUuid = 'existing-leaf'
    expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
    handle.leafUuid = null
    const home = record.accountHome.path
    record.accountHome.path = join(root, 'missing-account')
    expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
    record.accountHome.path = home
    database.close()
    expect(await canStartEmptyClaudeSession(record, database)).toBe(false)
  })
})
