import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openJournalDatabase } from '../../../native-chat/agent-session-journal/database/journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import {
  journalDatabasePath,
  journalDomainDatabasePath
} from '../../../native-chat/agent-session-journal/database/journal-host-database'
import { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { sweepAgentSessionAttachments } from '../../../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { structuredAgentSessionAttachmentSweepFacts } from './structured-agent-session-attachment-sweep'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

it('expires a failed unadopted chat upload after its original journal is moved away', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-attachment-custody-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  await initializeJournalDomainDatabase(root)
  source.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('failed-chat', '{}')
  source
    .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    .run('claimed', 'failed-chat', 100)
  source.exec('DROP TABLE journal_sessions')
  source.close()
  const now = 2_000_000_000_000
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000)
  const attachments = agentSessionAttachmentStoreRoot(root)
  const upload = join(attachments, 'claimed')
  mkdirSync(upload, { recursive: true })
  writeFileSync(join(upload, 'saved.txt'), 'original upload')
  utimesSync(upload, old, old)
  const open = () =>
    JournalSqlDatabase.open(root, {
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath(),
      onMaintenanceError: () => {}
    })
  const store = new AgentSessionAttachmentStore(attachments, { hasSession: () => true })
  const failed = await open()
  try {
    await sweepAgentSessionAttachments(
      store,
      structuredAgentSessionAttachmentSweepFacts(failed),
      now
    )
    expect(existsSync(upload)).toBe(true)
  } finally {
    await failed.close()
  }
  renameSync(journalDatabasePath(root), join(root, 'moved-original.db'))
  const reopened = await open()
  try {
    const facts = structuredAgentSessionAttachmentSweepFacts(reopened)
    await sweepAgentSessionAttachments(store, facts, now)
    await sweepAgentSessionAttachments(store, facts, now)
    expect(existsSync(upload)).toBe(false)
  } finally {
    await reopened.close()
  }
})

it('retains enumerated custody when a chat stops reconciliation while orphan cleanup continues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-attachment-custody-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => source.close())
  await initializeJournalDomainDatabase(root)
  const saved = source.prepare('INSERT INTO agent_session_records VALUES(?,?)')
  saved.run('blocked-chat', JSON.stringify({ sessionId: 'blocked-chat' }))
  saved.run('later-chat', JSON.stringify({ sessionId: 'later-chat' }))
  const claimed = '00000000-0000-4000-8000-000000000001'
  const orphan = '00000000-0000-4000-8000-000000000002'
  const marked = '00000000-0000-4000-8000-000000000003'
  source
    .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    .run(claimed, 'later-chat', 100)
  const now = 2_000_000_000_000
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000)
  const attachments = agentSessionAttachmentStoreRoot(root)
  for (const upload of [claimed, orphan, marked]) {
    const directory = join(attachments, upload)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'saved.txt'), 'original upload')
    utimesSync(directory, old, old)
  }
  const { db } = openJournalDomainDatabase(journalDomainDatabasePath(root))
  db.exec(`CREATE TRIGGER blocked BEFORE INSERT ON agent_session_records
    WHEN NEW.session_id='blocked-chat' BEGIN SELECT RAISE(ABORT,'database is locked'); END`)
  db.prepare('INSERT INTO agent_session_attachment_sweeps VALUES(?,?)').run(marked, 100)
  db.close()
  const open = () =>
    JournalSqlDatabase.open(root, {
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath(),
      onMaintenanceError: (error) => {
        throw error
      }
    })
  const store = new AgentSessionAttachmentStore(attachments, { hasSession: () => true })
  const interrupted = await open()
  try {
    await sweepAgentSessionAttachments(
      store,
      structuredAgentSessionAttachmentSweepFacts(interrupted),
      now
    )
    expect([claimed, orphan, marked].map((id) => existsSync(join(attachments, id)))).toEqual([
      true,
      false,
      false
    ])
  } finally {
    await interrupted.close()
  }
  const reopened = openJournalDomainDatabase(journalDomainDatabasePath(root)).db
  reopened.exec('DROP TRIGGER blocked')
  reopened.close()
  const recovered = await open()
  try {
    await sweepAgentSessionAttachments(
      store,
      structuredAgentSessionAttachmentSweepFacts(recovered),
      now
    )
    expect([claimed, orphan, marked].map((id) => existsSync(join(attachments, id)))).toEqual([
      true,
      false,
      false
    ])
  } finally {
    await recovered.close()
  }
})

it('cleans orphans after a complete custody snapshot whose source identity cannot be certified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-attachment-custody-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => source.close())
  source.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('saved-chat', '{}')
  source
    .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    .run('claimed', 'saved-chat', 100)
  source.pragma('wal_checkpoint(TRUNCATE)')
  linkSync(journalDatabasePath(root), join(root, 'original-link.db'))
  const now = 2_000_000_000_000
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000)
  const attachments = agentSessionAttachmentStoreRoot(root)
  for (const upload of ['claimed', 'orphan']) {
    const directory = join(attachments, upload)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'saved.txt'), 'stored upload')
    utimesSync(directory, old, old)
  }
  const store = new AgentSessionAttachmentStore(attachments, { hasSession: () => true })
  for (let launch = 0; launch < 2; launch++) {
    const orphan = join(attachments, 'orphan')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'saved.txt'), 'abandoned upload')
    utimesSync(orphan, old, old)
    const database = await JournalSqlDatabase.open(root, {
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath(),
      onMaintenanceError: () => {}
    })
    try {
      await sweepAgentSessionAttachments(
        store,
        structuredAgentSessionAttachmentSweepFacts(database),
        now
      )
      expect(['claimed', 'orphan'].map((id) => existsSync(join(attachments, id)))).toEqual([
        true,
        false
      ])
    } finally {
      await database.close()
    }
  }
})

it('continues orphan cleanup when permanent history failures have settled their upload custody', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-attachment-custody-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => source.close())
  source.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('saved-chat', '{}')
  await initializeJournalDomainDatabase(root)
  source
    .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    .run('claimed', 'saved-chat', 100)
  source.exec('DROP TABLE journal_sessions')
  const now = 2_000_000_000_000
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000)
  const attachments = agentSessionAttachmentStoreRoot(root)
  for (const upload of ['claimed', 'orphan']) {
    const directory = join(attachments, upload)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'saved.txt'), 'stored upload')
    utimesSync(directory, old, old)
  }
  const database = await JournalSqlDatabase.open(root, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: () => {}
  })
  try {
    const store = new AgentSessionAttachmentStore(attachments, { hasSession: () => true })
    await sweepAgentSessionAttachments(
      store,
      structuredAgentSessionAttachmentSweepFacts(database),
      now
    )
    expect(['claimed', 'orphan'].map((id) => existsSync(join(attachments, id)))).toEqual([
      true,
      false
    ])
  } finally {
    await database.close()
  }
})

it.each(['claim inventory', 'chat catalog'])(
  'keeps baseline cleanup when the original %s cannot be read',
  async (broken) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-attachment-custody-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const { db: source } = openJournalDatabase(journalDatabasePath(root))
    cleanup.push(() => source.close())
    source.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('saved-chat', '{}')
    await initializeJournalDomainDatabase(root)
    source
      .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
      .run('claimed', 'saved-chat', 100)
    if (broken === 'claim inventory') {
      source.exec(`DROP TABLE agent_session_attachment_claims;
      CREATE VIEW agent_session_attachment_claims AS
      SELECT upload_id,session_id,claimed_at FROM unavailable_claim_inventory`)
    } else {
      source.exec('DROP TABLE agent_session_records')
    }
    const now = 2_000_000_000_000
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000)
    const attachments = agentSessionAttachmentStoreRoot(root)
    const orphan = join(attachments, 'orphan')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'saved.txt'), 'abandoned upload')
    utimesSync(orphan, old, old)
    const database = await JournalSqlDatabase.open(root, {
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath(),
      onMaintenanceError: () => {}
    })
    try {
      const store = new AgentSessionAttachmentStore(attachments, { hasSession: () => true })
      await sweepAgentSessionAttachments(
        store,
        structuredAgentSessionAttachmentSweepFacts(database),
        now
      )
      expect(existsSync(orphan)).toBe(false)
    } finally {
      await database.close()
    }
  }
)
