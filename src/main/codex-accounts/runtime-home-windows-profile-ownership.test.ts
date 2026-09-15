import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { CodexRuntimeHomeService } from './runtime-home-service'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalCodexHome = process.env.CODEX_HOME
const originalOrcaCodexHome = process.env.ORCA_CODEX_HOME

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  restoreEnv('CODEX_HOME', originalCodexHome)
  restoreEnv('ORCA_CODEX_HOME', originalOrcaCodexHome)
})

describe('Windows System Default Codex home ownership', () => {
  it('selects the real home when the inherited environment names no custom CODEX_HOME', () => {
    // Why: Windows processes inherit the user/machine environment block at
    // creation, so an absent CODEX_HOME here is evidence, not a blind spot.
    const service = createWindowsService()

    expect(
      service.isHostSystemDefaultRealHomeSelected({
        HOME: 'C:\\Users\\profile-only-repro',
        SHELL: 'powershell.exe'
      })
    ).toBe(true)
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(true)
  })

  it('stays managed when the inherited environment sets a custom CODEX_HOME', () => {
    const service = createWindowsService()
    process.env.CODEX_HOME = 'C:\\custom\\codex-home'

    expect(
      service.isHostSystemDefaultRealHomeSelected({
        HOME: 'C:\\Users\\profile-only-repro',
        SHELL: 'powershell.exe'
      })
    ).toBe(false)
    // Why pinned together: a process-env override disables both lane routing and
    // session migration. They agree only on process env -- migration takes no
    // launchEnv, so the launch-env-only case below moves one and not the other.
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(false)
  })

  it('stays managed when a launch env carries a custom CODEX_HOME the process env lacks', () => {
    const service = createWindowsService()

    expect(
      service.isHostSystemDefaultRealHomeSelected({
        HOME: 'C:\\Users\\profile-only-repro',
        SHELL: 'powershell.exe',
        CODEX_HOME: 'C:\\custom\\codex-home'
      })
    ).toBe(false)
    // Pins the eligibility PRECHECK, which takes no launchEnv. The migration
    // launch itself does re-check it and refuses -- see the launchEnv-CODEX_HOME
    // toBeNull() case in runtime-home-real-home-lane-routing.test.ts (not the
    // missing-path one). Only the precheck is blind.
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(true)
  })

  it('falls back to the mirror on Windows when the trust-grant host is incapable', () => {
    const service = createWindowsService()
    // Why Windows specifically: an older codex binary is the likeliest real
    // fallback here, and the lane is SELECTED before the grant is attempted --
    // so selection being true while the lane is false is the shipped shape.
    service.setRealHomeLaneGate(() => false)
    const launchEnv = { HOME: 'C:\\Users\\profile-only-repro', SHELL: 'powershell.exe' }

    expect(service.isHostSystemDefaultRealHomeSelected(launchEnv)).toBe(true)
    expect(service.isHostSystemDefaultRealHome(launchEnv)).toBe(false)
  })
})

function createWindowsService(): CodexRuntimeHomeService {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  delete process.env.CODEX_HOME
  delete process.env.ORCA_CODEX_HOME
  const service = Object.create(CodexRuntimeHomeService.prototype) as CodexRuntimeHomeService
  Object.defineProperty(service, 'store', { value: createStore() })
  return service
}

function createStore() {
  const settings = {
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
  } as unknown as GlobalSettings
  return { getSettings: () => settings }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
