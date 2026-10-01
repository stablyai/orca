import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupFiles,
  profileStateDatabaseBackupPath,
  profileStateDatabaseBackups
} from './profile-state-backup-path'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function location(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-backup-path-'))
  directories.push(directory)
  return join(directory, 'profile-state.db')
}

describe('profile state database backup discovery', () => {
  it('lists immutable backup IDs newest-first without opening SQLite', () => {
    const path = location()
    const first = createProfileStateDatabaseBackupId(1_000)
    const last = createProfileStateDatabaseBackupId(2_000)
    writeFileSync(profileStateDatabaseBackupPath(path, first), 'first')
    writeFileSync(profileStateDatabaseBackupPath(path, last), 'second')
    writeFileSync(`${path}.backup.${last}.db.tmp`, 'incomplete staging')
    writeFileSync(`${path}.backup.invalid.db`, 'unrelated')
    expect(profileStateDatabaseBackups(path)).toEqual([
      { id: last, path: profileStateDatabaseBackupPath(path, last), createdAtMs: 2_000 },
      { id: first, path: profileStateDatabaseBackupPath(path, first), createdAtMs: 1_000 }
    ])
  })

  it('keeps reserved artifact names visible when their type needs recovery', () => {
    const path = location()
    const id = createProfileStateDatabaseBackupId()
    mkdirSync(profileStateDatabaseBackupPath(path, id))
    expect(profileStateDatabaseBackups(path).map((backup) => backup.id)).toEqual([id])
  })

  it('includes every existing backup sidecar in the recovery archive inventory', () => {
    const path = location()
    const backup = profileStateDatabaseBackupPath(path, createProfileStateDatabaseBackupId())
    const files = [backup, `${backup}-wal`, `${backup}-shm`, `${backup}-journal`]
    for (const file of files) {
      writeFileSync(file, 'recovery evidence')
    }
    expect(profileStateDatabaseBackupFiles(path)).toEqual(files)
  })

  it.each([
    '../profile-state.db',
    '1-../../outside',
    '0-00000000-0000-4000-8000-000000000000',
    '9007199254740992-00000000-0000-4000-8000-000000000000'
  ])('rejects invalid or escaping IDs: %s', (id) =>
    expect(() => profileStateDatabaseBackupPath(location(), id)).toThrow('ID is invalid')
  )

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe backup times: %s', (time) => {
    expect(() => createProfileStateDatabaseBackupId(time)).toThrow('positive safe integer')
  })

  it('treats only a missing directory as an empty recovery inventory', () => {
    const path = location()
    expect(profileStateDatabaseBackups(join(path, 'profile-state.db'))).toEqual([])
    writeFileSync(path, 'not a directory')
    expect(() => profileStateDatabaseBackups(join(path, 'profile-state.db'))).toThrow()
  })
})
