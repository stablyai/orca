import { spawnProcess } from '../../../shared/child-process/run-process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProfileStateCutoverFixture,
  canonicalProfileStateJson
} from '../profile-state-cutover-fixture'
import {
  exportProfileStateJson,
  importProfileStateJson,
  readProfileStateRevision
} from './profile-state-documents'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const crashDuringWriteScript = `
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(process.argv[1])
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE')
  db.prepare('DELETE FROM profile_state_documents').run()
  db.prepare('DELETE FROM profile_state_automation_runs').run()
  db.prepare('DELETE FROM profile_state_automation_runs_meta').run()
  db.prepare(\`
    UPDATE profile_state_meta
    SET value = ?
    WHERE key = 'revision'
  \`).run('999')
  process.stdout.write('transaction-ready\\n')
  setInterval(() => {}, 1_000)
`

const crashAfterCommittedWriteScript = `
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const { createHash } = require('node:crypto')
  const db = new DatabaseSync(process.argv[1])
  const payload = '{"theme":"committed"}'
  const hash = createHash('sha256').update(payload).digest('hex')
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE')
  db.prepare('DELETE FROM profile_state_documents').run()
  db.prepare('DELETE FROM profile_state_automation_runs').run()
  db.prepare("UPDATE profile_state_automation_runs_meta SET presence = 'document', domain_version = 1, revision = 0, updated_at = 0, content_hash = ''").run()
  db.prepare(\`
    INSERT INTO profile_state_documents
       (domain, payload, domain_version, revision, updated_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)\`
  ).run('settings', payload, 1, 999, 999, hash)
  db.prepare(\`
    UPDATE profile_state_meta
    SET value = ?
    WHERE key = 'revision'
  \`).run('999')
  db.exec('COMMIT')
  process.stdout.write('transaction-committed\\n')
  setInterval(() => {}, 1_000)
`

const crashDuringCheckpointScript = `
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const dbPath = process.argv[1]
  const writer = new DatabaseSync(dbPath, { timeout: 5_000 })
  const reader = new DatabaseSync(dbPath, { timeout: 5_000 })
  writer.exec('PRAGMA wal_autocheckpoint = 0')
  writer.exec('BEGIN IMMEDIATE')
  writer.prepare(
    \`UPDATE profile_state_meta SET value = value WHERE key = 'revision'\`
  ).run()
  writer.exec('COMMIT')
  reader.exec('BEGIN')
  reader.prepare("SELECT value FROM profile_state_meta WHERE key = 'revision'").get()
  // SQLITE_PRAGMA is action code 19; the reader keeps TRUNCATE checkpointing active after this callback returns.
  writer.setAuthorizer((action) => {
    if (action === 19) {
      process.stdout.write('checkpoint-started\\n')
    }
    return 0
  })
  writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
  process.stdout.write('checkpoint-complete\\n')
`

async function killAfterChildReady(dbPath: string, script: string, marker: string): Promise<void> {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', script, dbPath],
    timeoutMs: null
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {})
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const onData = (chunk: Buffer | string): void => {
        output += String(chunk)
        if (output.includes(marker)) {
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.once('error', reject)
    })
    child.kill('SIGKILL')
    await new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve())
      child.once('error', reject)
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}

async function killAfterUncommittedWrite(dbPath: string): Promise<void> {
  await killAfterChildReady(dbPath, crashDuringWriteScript, 'transaction-ready')
}

describe('profile state crash recovery', () => {
  it('rolls back an uncommitted SQLite write and accepts the next import', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = profileStateDatabaseFile(directory)
    const fixture = buildProfileStateCutoverFixture()

    const initial = openProfileStateDatabase(dbPath, 'profile-a')
    importProfileStateJson(initial.db, JSON.stringify(fixture), { now: () => 100 })
    initial.db.close()

    await killAfterUncommittedWrite(dbPath)

    const recovered = openProfileStateDatabase(dbPath, 'profile-a')
    try {
      expect(recovered.readOnly).toBe(false)
      expect(readProfileStateRevision(recovered.db)).toBe(1)
      expect(canonicalProfileStateJson(JSON.parse(exportProfileStateJson(recovered.db)))).toBe(
        canonicalProfileStateJson(fixture)
      )

      const replacement = {
        ...fixture,
        futureTopLevelExtension: { keep: 'replacement', nullable: null }
      }
      expect(
        importProfileStateJson(recovered.db, JSON.stringify(replacement), { now: () => 200 })
      ).toBe(2)
      expect(canonicalProfileStateJson(JSON.parse(exportProfileStateJson(recovered.db)))).toBe(
        canonicalProfileStateJson(replacement)
      )
    } finally {
      recovered.db.close()
    }
  })

  it('preserves a committed SQLite write after process termination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = profileStateDatabaseFile(directory)
    const initial = openProfileStateDatabase(dbPath, 'profile-a')
    importProfileStateJson(initial.db, JSON.stringify(buildProfileStateCutoverFixture()), {
      now: () => 100
    })
    initial.db.close()

    await killAfterChildReady(dbPath, crashAfterCommittedWriteScript, 'transaction-committed')

    const recovered = openProfileStateDatabase(dbPath, 'profile-a')
    try {
      expect(recovered.readOnly).toBe(false)
      expect(readProfileStateRevision(recovered.db)).toBe(999)
      expect(JSON.parse(exportProfileStateJson(recovered.db))).toEqual({
        settings: { theme: 'committed' }
      })
    } finally {
      recovered.db.close()
    }
  })

  it('recovers a committed database when checkpointing is interrupted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-checkpoint-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = profileStateDatabaseFile(directory)
    const fixture = buildProfileStateCutoverFixture()
    const initial = openProfileStateDatabase(dbPath, 'profile-a')
    importProfileStateJson(initial.db, JSON.stringify(fixture), { now: () => 100 })
    initial.db.close()

    await killAfterChildReady(dbPath, crashDuringCheckpointScript, 'checkpoint-started')

    const recovered = openProfileStateDatabase(dbPath, 'profile-a')
    try {
      expect(recovered.readOnly).toBe(false)
      expect(readProfileStateRevision(recovered.db)).toBe(1)
      expect(canonicalProfileStateJson(JSON.parse(exportProfileStateJson(recovered.db)))).toBe(
        canonicalProfileStateJson(fixture)
      )
    } finally {
      recovered.db.close()
    }
  })
})
