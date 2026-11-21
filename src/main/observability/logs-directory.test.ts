import type * as NodeOs from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, platform: () => 'win32' }
})

vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  hasAppEnvironment: () => false,
  getAppEnvironment: vi.fn()
}))

import { getLogsDirectory } from './logs-directory'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('falls back to homedir when APPDATA is blank on Windows', () => {
  vi.stubEnv('APPDATA', '')

  expect(getLogsDirectory()).toBe(join(homedir(), 'Orca', 'logs'))
})
