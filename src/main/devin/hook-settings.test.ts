import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDevinConfigPath } from './hook-settings'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

it('falls back to home AppData\\Roaming when APPDATA is blank on Windows', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('APPDATA', '   ')

  expect(getDevinConfigPath()).toBe(join(homedir(), 'AppData', 'Roaming', 'devin', 'config.json'))
})
