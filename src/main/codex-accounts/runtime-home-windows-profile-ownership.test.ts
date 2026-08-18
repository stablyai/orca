import { afterEach, describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
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
  it('stays managed when PowerShell profile state cannot be inspected', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    delete process.env.CODEX_HOME
    delete process.env.ORCA_CODEX_HOME

    const service = Object.create(CodexRuntimeHomeService.prototype) as CodexRuntimeHomeService
    Object.defineProperty(service, 'store', { value: createStore() })

    expect(
      service.isHostSystemDefaultRealHomeSelected({
        HOME: 'C:\\Users\\profile-only-repro',
        SHELL: 'powershell.exe'
      })
    ).toBe(false)
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(true)
  })

  it('uses the real home only when the Windows workspace would rediscover it', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    delete process.env.CODEX_HOME
    delete process.env.ORCA_CODEX_HOME

    const service = Object.create(CodexRuntimeHomeService.prototype) as CodexRuntimeHomeService
    Object.defineProperty(service, 'store', { value: createStore() })
    service.setRealHomeLaneGate(() => true)
    const userProfile = dirname(getSystemCodexHomePath())

    expect(service.isHostSystemDefaultRealHomeSelected(undefined, userProfile)).toBe(true)
    expect(service.isHostSystemDefaultRealHome(undefined, userProfile)).toBe(true)
    expect(
      service.isHostSystemDefaultRealHomeSelected(undefined, join(userProfile, 'project'))
    ).toBe(false)
    expect(
      service.isHostSystemDefaultRealHomeSelected(
        { CODEX_HOME: join(userProfile, 'custom-codex-home') },
        userProfile
      )
    ).toBe(false)

    service.setRealHomeLaneGate(() => false)
    expect(service.isHostSystemDefaultRealHome(undefined, userProfile)).toBe(false)
  })
})

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
