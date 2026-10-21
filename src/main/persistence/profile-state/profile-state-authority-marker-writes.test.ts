import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../../durable-file-write'
import { prepareProfileProjectDomainChanges } from '../../orca-profiles/profile-project-domain-changes'
import {
  readProfileProjectTransferState,
  writeProfileProjectDomainChanges
} from '../../orca-profiles/profile-project-domain-state'
import { writeSerializedProfileState } from '../../orca-profiles/profile-project-state-file'
import {
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from './profile-state-authority-marker'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import { updateAgentHookSettingsFromProfileState } from './profile-state-offline-settings'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'

const roots: string[] = []
const before = JSON.stringify({
  settings: { agentStatusHooksEnabled: true },
  futureDomain: { keep: '雪' }
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-authority-marker-writes-'))
  roots.push(root)
  const profileId = 'marker-writer'
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  const location = {
    profileId,
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: join(directory, 'profile-state.db')
  }
  const opened = openProfileStateDatabase(location.databaseFile, profileId)
  try {
    importProfileStateJson(opened.db, before)
  } finally {
    opened.db.close()
  }
  const snapshot = readProfileProjectTransferState(profileId, root)
  if (snapshot.revision === undefined || snapshot.documents === undefined) {
    throw new Error('Fixture requires SQLite')
  }
  const changes = prepareProfileProjectDomainChanges(snapshot.revision, snapshot.documents, {
    ...snapshot.state,
    settings: { ...snapshot.state.settings, agentStatusHooksEnabled: false }
  })
  return {
    location,
    write: {
      hooks: () => updateAgentHookSettingsFromProfileState(location, false),
      domains: () => writeProfileProjectDomainChanges(profileId, root, changes),
      replay: () =>
        writeSerializedProfileState(
          profileId,
          root,
          JSON.stringify({ settings: { agentStatusHooksEnabled: false } }),
          { expectedRevision: snapshot.revision }
        )
    }
  }
}

function read(location: ReturnType<typeof fixture>['location']) {
  const opened = openProfileStateDatabaseReadOnly(location.databaseFile, location.profileId)
  try {
    return readProfileStateSnapshot(opened.db)
  } finally {
    opened.db.close()
  }
}

describe.each(['hooks', 'domains', 'replay'] as const)('%s direct canonical writer', (route) => {
  it('requires durable authority evidence before mutating an existing SQL profile', () => {
    const { location, write } = fixture()
    expect(hasProfileStateAuthorityMarker(location.databaseFile)).toBe(false)
    const durableWrite = durableFileWrite.writeFileDurableSync
    const injected = vi
      .spyOn(durableFileWrite, 'writeFileDurableSync')
      .mockImplementation((temporary, target, payload) => {
        if (target === profileStateAuthorityMarkerPath(location.databaseFile)) {
          throw new Error('marker publication failed')
        }
        return durableWrite(temporary, target, payload)
      })
    expect(write[route]).toThrow('marker publication failed')
    expect(read(location)).toMatchObject({ revision: 1, json: before })
    injected.mockRestore()

    write[route]()
    expect(hasProfileStateAuthorityMarker(location.databaseFile)).toBe(true)
    const committed = read(location)
    expect(committed.revision).toBe(2)
    expect(JSON.parse(committed.json).settings.agentStatusHooksEnabled).toBe(false)
  })

  it.each([false, true])('refuses lost SQL with stale JSON present=%s', (hasJson) => {
    const { location, write } = fixture()
    write[route]()
    for (const path of profileStateDatabaseFiles(location.databaseFile)) {
      rmSync(path, { force: true })
    }
    if (hasJson) {
      writeFileSync(location.dataFile, before)
    }
    expect(write[route]).toThrow()
    expect(existsSync(location.databaseFile)).toBe(false)
    expect(existsSync(location.dataFile)).toBe(hasJson)
    if (hasJson) {
      expect(readFileSync(location.dataFile, 'utf8')).toBe(before)
    }
  })
})
