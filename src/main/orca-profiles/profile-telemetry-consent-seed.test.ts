import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'
import * as database from '../persistence/profile-state/profile-state-database'
import { exportProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile,
  seedNewOrcaProfileTelemetryConsent
} from './profile-index-store'

const telemetry = {
  optedIn: false,
  installId: 'retained-install-id',
  existedBeforeTelemetryRelease: true
}
let root: string
const profileId = 'new-profile'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-profile-consent-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTreeSync(root)
})

describe('new profile consent seeding', () => {
  it('inherits consent and install identity directly into SQLite alongside the active runtime', () => {
    const runtime = acquireProfileStateRuntimeAdmission(root)
    try {
      seedNewOrcaProfileTelemetryConsent(profileId, telemetry, root)
      const opened = database.openProfileStateDatabaseReadOnly(
        getOrcaProfileStateDatabaseFile(profileId, root),
        profileId
      )
      try {
        expect(JSON.parse(exportProfileStateJson(opened.db))).toEqual({ settings: { telemetry } })
      } finally {
        opened.db.close()
      }
      expect(existsSync(getOrcaProfileDataFile(profileId, root))).toBe(false)
      expect(() => runtime.assertActive()).not.toThrow()
    } finally {
      runtime.release()
    }
    const maintenance = acquireProfileStateMaintenance(root)
    maintenance.release()
  })

  it('preserves established SQLite consent on a repeated seed', () => {
    seedNewOrcaProfileTelemetryConsent(profileId, telemetry, root)
    seedNewOrcaProfileTelemetryConsent(profileId, { ...telemetry, installId: 'replacement' }, root)
    const opened = database.openProfileStateDatabaseReadOnly(
      getOrcaProfileStateDatabaseFile(profileId, root),
      profileId
    )
    try {
      expect(JSON.parse(exportProfileStateJson(opened.db))).toEqual({ settings: { telemetry } })
    } finally {
      opened.db.close()
    }
  })

  it('preserves existing JSON as input for its later import', () => {
    const path = getOrcaProfileDataFile(profileId, root)
    const original = '{"settings":{"telemetry":{"installId":"older"}}}'
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, original)

    seedNewOrcaProfileTelemetryConsent(profileId, telemetry, root)

    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
  })

  it('refuses an incapable runtime before admission or profile creation', () => {
    vi.spyOn(database, 'isProfileStateSqliteAvailable').mockReturnValue(false)
    expect(() => seedNewOrcaProfileTelemetryConsent(profileId, telemetry, root)).toThrow(
      'bundled Orca runtime'
    )
    expect(existsSync(join(root, '.profile-state-access'))).toBe(false)
    expect(existsSync(join(root, 'profiles'))).toBe(false)
  })

  it('refuses seeding while maintenance owns the root', () => {
    const maintenance = acquireProfileStateMaintenance(root)
    try {
      expect(() => seedNewOrcaProfileTelemetryConsent(profileId, telemetry, root)).toThrow()
      expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
    } finally {
      maintenance.release()
    }
  })

  it.each(['orca-data.json.bak.0', 'orca-data.json.sqlite-export.1.json', 'profile-state.db-wal'])(
    'retains missing-authority evidence in %s',
    (name) => {
      const directory = dirname(getOrcaProfileDataFile(profileId, root))
      mkdirSync(directory, { recursive: true })
      const evidence = join(directory, name)
      writeFileSync(evidence, 'retained recovery evidence')

      expect(() => seedNewOrcaProfileTelemetryConsent(profileId, telemetry, root)).toThrow()

      expect(existsSync(getOrcaProfileDataFile(profileId, root))).toBe(false)
      expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
      expect(readFileSync(evidence, 'utf8')).toBe('retained recovery evidence')
    }
  )
})
