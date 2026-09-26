import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasMissingProfileStateDatabaseWithRetainedExport,
  readActiveProfileId,
  readPersistedHttp1CompatibilityMode
} from './http1-compatibility-profile-state'
import { profileStateJsonExportPath } from '../persistence/profile-state/profile-state-export-path'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-http1-profile-state-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeIndex(userDataPath: string, activeProfileId: string): void {
  writeFileSync(
    join(userDataPath, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProfileId,
      profiles: [{ id: activeProfileId }]
    })
  )
}

describe('pre-ready profile-state compatibility lookup', () => {
  it('uses the legacy install-level JSON before a profile index exists', () => {
    const userDataPath = createUserData()
    writeFileSync(
      join(userDataPath, 'orca-data.json'),
      JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
    )

    expect(readActiveProfileId(userDataPath)).toBeUndefined()
    expect(readPersistedHttp1CompatibilityMode(userDataPath)).toBe(true)
  })

  it('reads only the active profile JSON once the index is valid', () => {
    const userDataPath = createUserData()
    writeIndex(userDataPath, 'work')
    const profileDirectory = join(userDataPath, 'profiles', 'work')
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(
      join(userDataPath, 'orca-data.json'),
      JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
    )
    rmSync(join(userDataPath, 'orca-data.json'))
    writeFileSync(
      join(profileDirectory, 'orca-data.json'),
      JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
    )

    expect(readActiveProfileId(userDataPath)).toBe('work')
    expect(readPersistedHttp1CompatibilityMode(userDataPath)).toBe(true)
  })

  it.each(['-wal', '-shm', '-journal'])('fails closed when only SQLite %s remains', (suffix) => {
    const userDataPath = createUserData()
    writeIndex(userDataPath, 'work')
    const profileDirectory = join(userDataPath, 'profiles', 'work')
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(
      join(profileDirectory, 'orca-data.json'),
      JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
    )
    writeFileSync(join(profileDirectory, `profile-state.db${suffix}`), 'orphaned')

    expect(readPersistedHttp1CompatibilityMode(userDataPath)).toBe(false)

    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{ malformed')
    writeFileSync(
      join(userDataPath, 'orca-data.json'),
      JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
    )
    expect(readActiveProfileId(userDataPath)).toBe(null)
    expect(readPersistedHttp1CompatibilityMode(userDataPath)).toBe(false)
  })

  it.each(['json-export', 'database-backup'])(
    'fails closed when SQLite is missing but a retained %s remains',
    (artifact) => {
      const userDataPath = createUserData()
      writeIndex(userDataPath, 'work')
      const profileDirectory = join(userDataPath, 'profiles', 'work')
      mkdirSync(profileDirectory, { recursive: true })
      const dataFile = join(profileDirectory, 'orca-data.json')
      writeFileSync(
        dataFile,
        JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
      )
      writeFileSync(
        artifact === 'json-export'
          ? profileStateJsonExportPath(dataFile, 7)
          : join(
              profileDirectory,
              'profile-state.db.backup.1789999999999-00000000-0000-4000-8000-000000000000.db'
            ),
        readFileSync(dataFile)
      )

      expect(readPersistedHttp1CompatibilityMode(userDataPath)).toBe(false)
    }
  )

  it.each(['json-export', 'database-backup'])(
    'detects a missing profile database with a retained %s',
    (artifact) => {
      const userDataPath = createUserData()
      writeIndex(userDataPath, 'work')
      const profileDirectory = join(userDataPath, 'profiles', 'work')
      mkdirSync(profileDirectory, { recursive: true })
      const dataFile = join(profileDirectory, 'orca-data.json')
      writeFileSync(
        dataFile,
        JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } })
      )
      writeFileSync(
        artifact === 'json-export'
          ? profileStateJsonExportPath(dataFile, 7)
          : join(
              profileDirectory,
              'profile-state.db.backup.1789999999999-00000000-0000-4000-8000-000000000000.db'
            ),
        readFileSync(dataFile)
      )

      expect(hasMissingProfileStateDatabaseWithRetainedExport(userDataPath, 'work')).toBe(true)
    }
  )
})
