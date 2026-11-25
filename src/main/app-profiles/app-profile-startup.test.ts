import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { electronApp, profile } = vi.hoisted(() => ({
  electronApp: { setPath: vi.fn(), setName: vi.fn(), commandLine: { hasSwitch: vi.fn() } },
  profile: { id: 'work', name: 'Orca - Work', bundleId: 'b', userDataPath: '' }
}))
vi.mock('electron', () => ({ app: electronApp }))
vi.mock('./app-profile', () => ({ resolveRunningAppProfile: () => profile }))

import { configureAppProfileStartup } from './app-profile-startup'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-profile-startup-'))
  profile.userDataPath = join(root, 'work')
  vi.clearAllMocks()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it("pins the profile's userData, marks it and names its own Keychain item", () => {
  electronApp.commandLine.hasSwitch.mockReturnValue(false)
  configureAppProfileStartup(false)
  expect(electronApp.setPath).toHaveBeenCalledWith('userData', profile.userDataPath)
  expect(existsSync(join(profile.userDataPath, 'orca-app-profile.json'))).toBe(true)
  expect(electronApp.setName).toHaveBeenCalledWith('orca-work')
})

it('keeps a --user-data-dir folder as given', () => {
  electronApp.commandLine.hasSwitch.mockReturnValue(true)
  configureAppProfileStartup(false)
  expect(electronApp.setPath).not.toHaveBeenCalled()
  expect(existsSync(join(profile.userDataPath, 'orca-app-profile.json'))).toBe(false)
  expect(electronApp.setName).toHaveBeenCalledWith('orca-work')
})
