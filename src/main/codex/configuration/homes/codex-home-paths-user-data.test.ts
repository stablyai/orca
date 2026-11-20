import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getOrcaUserDataPath } from './codex-home-paths'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

it('falls back to home AppData\\Roaming when APPDATA is blank on Windows', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('ORCA_USER_DATA_PATH', '   ')
  vi.stubEnv('APPDATA', '')

  expect(getOrcaUserDataPath()).toBe(join(homedir(), 'AppData', 'Roaming', 'orca'))
})
