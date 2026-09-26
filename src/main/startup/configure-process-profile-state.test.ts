import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn(() => '') }
  }
}))

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('pre-ready profile-state recovery boundary', () => {
  it('ignores a matching marker when SQLite is missing but an export remains', async () => {
    const { shouldDisableHttp2ForElectronNetworking } = await import('./configure-process')
    const { writeHttp1CompatibilityMarker } = await import('./http1-compatibility-marker')
    const { profileStateJsonExportPath } =
      await import('../persistence/profile-state/profile-state-export-path')
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-http1-profile-'))
    temporaryDirectories.push(userDataPath)
    const profileDirectory = join(userDataPath, 'profiles', 'profile-b')
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(
      join(userDataPath, 'orca-profile-index.json'),
      JSON.stringify({ activeProfileId: 'profile-b', profiles: [{ id: 'profile-b' }] })
    )
    const dataFile = join(profileDirectory, 'orca-data.json')
    writeFileSync(dataFile, JSON.stringify({ settings: { electronHttp1CompatibilityMode: true } }))
    writeHttp1CompatibilityMarker(userDataPath, true, 'profile-b')
    writeFileSync(profileStateJsonExportPath(dataFile, 7), '{}')

    expect(shouldDisableHttp2ForElectronNetworking({ env: {}, userDataPath })).toBe(false)
  })
})
