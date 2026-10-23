import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { __resetPowerShellProfileEnvCache } from '../pty/powershell-profile-env'
import { CodexRuntimeHomeService } from './runtime-home-service'

// Why: keep the host's own registry-named Documents folder out of the probe.
vi.mock('../windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => {
    throw new Error('no registry in tests')
  }
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalCodexHome = process.env.CODEX_HOME
const originalOrcaCodexHome = process.env.ORCA_CODEX_HOME
const temporaryProfiles: string[] = []

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  restoreEnv('CODEX_HOME', originalCodexHome)
  restoreEnv('ORCA_CODEX_HOME', originalOrcaCodexHome)
  __resetPowerShellProfileEnvCache()
  vi.unstubAllEnvs()
  for (const path of temporaryProfiles.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Windows System Default Codex home ownership', () => {
  it('routes a user with no CODEX_HOME in any PowerShell profile to the real home', () => {
    const service = createWindowsService()

    expect(service.isHostSystemDefaultRealHomeSelected({ USERPROFILE: createUserProfile() })).toBe(
      true
    )
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(true)
  })

  it('stays managed when a PowerShell profile points CODEX_HOME elsewhere (#9788)', () => {
    const userProfile = createUserProfile()
    const profileDir = join(userProfile, 'Documents', 'WindowsPowerShell')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'Microsoft.PowerShell_profile.ps1'),
      "$env:CODEX_HOME = 'C:\\custom-codex'\r\n"
    )
    const service = createWindowsService()

    expect(service.isHostSystemDefaultRealHomeSelected({ USERPROFILE: userProfile })).toBe(false)
  })

  it('stays managed when a Git Bash login file exports CODEX_HOME elsewhere', () => {
    const userProfile = createUserProfile()
    writeFileSync(join(userProfile, '.bash_profile'), 'export CODEX_HOME="$HOME/custom-codex"\n')
    const service = createWindowsService()

    expect(service.isHostSystemDefaultRealHomeSelected({ USERPROFILE: userProfile })).toBe(false)
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

function createUserProfile(): string {
  const userProfile = mkdtempSync(join(tmpdir(), 'orca-win-profile-'))
  temporaryProfiles.push(userProfile)
  // Why: all-users profiles and the process-wide checks must read this sandbox too.
  vi.stubEnv('USERPROFILE', userProfile)
  vi.stubEnv('SystemRoot', join(userProfile, 'Windows'))
  vi.stubEnv('ProgramFiles', join(userProfile, 'Program Files'))
  return userProfile
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
