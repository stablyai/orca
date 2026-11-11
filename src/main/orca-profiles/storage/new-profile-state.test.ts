import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'
import type { PersistedState } from '../../../shared/persisted-state-types'
import '../../../shared/worktree/id'
import '../../../shared/workspace-scope'
import '../../persistence/profile-state/profile-state-access'
import * as database from '../../persistence/profile-state/profile-state-database'
import { exportProfileStateJson } from '../../persistence/profile-state/profile-state-documents'
import '../../persistence/profile-state/profile-state-store-factory'
import '../profile-index-store'
import { getOrcaProfileDataFile, getOrcaProfileStateDatabaseFile } from '../profile-storage-paths'
import { initializeNewOrcaProfileState } from './new-profile-state'

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

function readPublishedState(): PersistedState {
  const opened = database.openProfileStateDatabaseReadOnly(
    getOrcaProfileStateDatabaseFile(profileId, root),
    profileId
  )
  try {
    const state: PersistedState = JSON.parse(exportProfileStateJson(opened.db))
    return state
  } finally {
    opened.db.close()
  }
}

describe('new desktop profile initialization', () => {
  it('starts an inherited install with its own existing-profile milestone state', () => {
    initializeNewOrcaProfileState(
      profileId,
      {
        optedIn: true,
        installId: 'retained-install-id',
        existedBeforeTelemetryRelease: false,
        protectedMilestones: {
          installCohort: 'fresh',
          firstAgentInteractionDay: 20_766,
          meaningfulActivityDay: 20_766
        }
      },
      root
    )

    expect(readPublishedState().settings.telemetry).toEqual({
      optedIn: true,
      installId: 'retained-install-id',
      existedBeforeTelemetryRelease: false,
      protectedMilestones: { installCohort: 'existing' }
    })
  })

  it('preserves existing JSON as input for its later import', () => {
    const path = getOrcaProfileDataFile(profileId, root)
    const original = '{"settings":{"telemetry":{"installId":"older"}}}'
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, original)

    initializeNewOrcaProfileState(profileId, telemetry, root)

    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
  })
})
