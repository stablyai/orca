import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openJournalDomainDatabase } from '../../../src/main/native-chat/agent-session-journal/database/journal-domain-database'
import {
  ensureSubmissionExportTables,
  openSubmissionExport
} from '../../../src/main/native-chat/agent-session-journal/journal-submission-export'

const [action, profile, manifestDigest, writerEpoch] = process.argv.slice(2)
if (!profile || realpathSync(profile) !== resolve(profile) || !lstatSync(profile).isDirectory()) {
  throw new Error('invalid staged profile')
}
const file = join(profile, 'agent-session-domain.db')
if (action === 'template') {
  if (existsSync(file)) {
    throw new Error('template destination exists')
  }
  const { db } = openJournalDomainDatabase(file)
  db.close()
  chmodSync(file, 0o600)
} else if (action === 'enroll') {
  if (
    !existsSync(file) ||
    !writerEpoch ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(writerEpoch)
  ) {
    throw new Error('invalid enrollment')
  }
  const bytes = readFileSync(join(profile, 'migration-manifest.json'))
  if (createHash('sha256').update(bytes).digest('hex') !== manifestDigest) {
    throw new Error('snapshot manifest mismatch')
  }
  const manifest = JSON.parse(bytes.toString())
  const { db } = openJournalDomainDatabase(file)
  try {
    db.exec('BEGIN IMMEDIATE')
    const sessions = db
      .prepare('SELECT session_id,workspace_id FROM journal_chat_state ORDER BY session_id')
      .all()
    if (
      !sessions.length ||
      sessions.some((r) => r.workspace_id !== manifest.workspace) ||
      JSON.stringify(sessions.map((r) => r.session_id)) !== JSON.stringify(manifest.sessions)
    ) {
      throw new Error('staged membership differs')
    }
    ensureSubmissionExportTables(db)
    db.prepare(
      'INSERT INTO journal_export_enrollment(singleton,bot_id,workspace_id,writer_epoch) VALUES(1,?,?,?)'
    ).run(manifest.bot_id, manifest.workspace, writerEpoch)
    openSubmissionExport(db)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  chmodSync(file, 0o600)
} else {
  throw new Error('expected template or enroll')
}
