import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPersistedStateJson } from '../../persistence/persistence-test-harness'
import { getOrcaProfileDataFile } from '../profile-storage-paths'
import { initializeNewOrcaProfileState } from './new-profile-state'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-new-profile-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('opens an added profile in ~ without carrying the first launch layout', () => {
  initializeNewOrcaProfileState(
    'added',
    {
      optedIn: true,
      installId: 'install',
      existedBeforeTelemetryRelease: false,
      firstLaunchLayout: 'project-picker',
      firstLaunchLayoutReport: 'sent'
    },
    dir
  )
  const state = JSON.parse(readPersistedStateJson(getOrcaProfileDataFile('added', dir), 'added'))
  expect(state.repos.map((repo: { displayName: string }) => repo.displayName)).toEqual(['~'])
  expect(state.settings.telemetry.installId).toBe('install')
  expect(state.settings.telemetry).not.toHaveProperty('firstLaunchLayout')
  expect(state.settings.telemetry).not.toHaveProperty('firstLaunchLayoutReport')
})
