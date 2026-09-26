import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { readProfileStateSnapshot } from './profile-state-documents'
import { runProfileStateBackupWorker } from './profile-state-backup-worker'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

export type ProfileStateRuntimePreflightResult = {
  sqliteVersion: string
  revision: number
}

/** Qualify the installed writer and backup without opening an existing user profile. */
export async function preflightProfileStateRuntime(
  options: { workerPath?: string; backupWorkerPath?: string; timeoutMs?: number } = {}
): Promise<ProfileStateRuntimePreflightResult> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-profile-preflight-'))
  const databasePath = join(directory, 'profile.db')
  const targetPath = join(directory, 'backup.db')
  const profileId = randomUUID()
  const payload = JSON.stringify({ witness: profileId, unicode: '雪 🐋', surrogate: '\ud800' })
  let writer: ProfileStateWriteWorkerClient | undefined
  try {
    const initial = openProfileStateDatabase(databasePath, profileId)
    let revision: number
    try {
      revision = readProfileStateSnapshot(initial.db).revision
    } finally {
      initial.db.close()
    }
    writer = new ProfileStateWriteWorkerClient({ databasePath, profileId, revision }, options)
    await writer.ready
    const committedRevision = await writer.writeCompleteSerializedDomains([
      { domain: 'preflight', payload }
    ])
    await writer.close()
    await runProfileStateBackupWorker(
      { databasePath, profileId, targetPath },
      { workerPath: options.backupWorkerPath, timeoutMs: options.timeoutMs }
    )
    const backup = openProfileStateDatabaseReadOnly(targetPath, profileId)
    try {
      const snapshot = readProfileStateSnapshot(backup.db)
      if (snapshot.revision !== committedRevision || snapshot.json !== `{"preflight":${payload}}`) {
        throw new Error('Profile runtime backup did not preserve the acknowledged state')
      }
      const row = backup.db.prepare('SELECT sqlite_version() AS version').get()
      if (typeof row?.version !== 'string') {
        throw new Error('Profile runtime did not report its SQLite version')
      }
      return { sqliteVersion: row.version, revision: committedRevision }
    } finally {
      backup.db.close()
    }
  } finally {
    try {
      await writer?.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
