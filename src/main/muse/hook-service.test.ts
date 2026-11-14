import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMuseSettingsText } from './hook-config-json'
import { MuseHookService } from './hook-service'

// Isolate managed scripts and Muse settings from real HOME/XDG configuration.
let home: string
let originalHome: string | undefined
let originalXdg: string | undefined
let originalProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-muse-hook-'))
  originalProfile = process.env.USERPROFILE
  process.env.USERPROFILE = home
  originalHome = process.env.HOME
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg
  }
  if (originalProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalProfile
  }
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.config', 'muse', 'settings.json')

describe('MuseHookService', () => {
  it('does not overwrite a user-managed hooks pointer during install', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    const userPath = '/user-owned/muse-hooks.json'
    writeFileSync(configPath(), JSON.stringify({ schema_version: 1, managed_hooks_path: userPath }))
    const status = new MuseHookService().install()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain(userPath)
    expect(
      parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')?.managed_hooks_path
    ).toBe(userPath)
  })
})
