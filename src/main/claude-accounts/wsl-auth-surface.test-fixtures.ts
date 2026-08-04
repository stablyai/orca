import { vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { ClaudeManagedAccount, GlobalSettings } from '../../shared/types'

/**
 * Shared harness for the Claude WSL auth-surface suites: a temp dir stands in for a distro home
 * (a real `\\wsl.localhost\` share is unavailable off Windows) and `uncBlindPaths` reproduces the
 * 9P share's habit of reporting ENOENT for files that exist.
 */
export const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  wslHomeDirs: new Map<string, string>(),
  uncBlindPaths: new Set<string>()
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

export function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT'
  })
}

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

export function beginWslAuthSurfaceTest(): void {
  setPlatform('win32')
  vi.resetModules()
  vi.clearAllMocks()
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-wsl-auth-data-'))
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-wsl-auth-home-'))
  testState.wslHomeDirs = new Map()
  testState.uncBlindPaths = new Set()
  mkdirSync(join(testState.fakeHomeDir, '.claude'), { recursive: true })
}

export function endWslAuthSurfaceTest(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  testState.uncBlindPaths = new Set()
  rmSync(testState.userDataDir, { recursive: true, force: true })
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  for (const homeDir of testState.wslHomeDirs.values()) {
    rmSync(homeDir, { recursive: true, force: true })
  }
}

export function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings(testState.fakeHomeDir), ...overrides }
}

export function createStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

export function createCredentialsJson(
  email: string,
  accessToken: string,
  expiresAt?: number
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      email,
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt: expiresAt ?? Date.now() + 60_000
    }
  })}\n`
}

/** A distro home carrying a realistic profile plus the user's own login. */
export function createWslDistroHome(distro: string, ownerEmail: string): string {
  const homeDir = mkdtempSync(join(tmpdir(), `orca-wsl-${distro.toLowerCase()}-`))
  testState.wslHomeDirs.set(distro, homeDir)
  const profileDir = join(homeDir, '.claude')
  mkdirSync(join(profileDir, 'plugins'), { recursive: true })
  writeFileSync(
    join(profileDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'my-statusline' } }),
    'utf-8'
  )
  writeFileSync(join(profileDir, 'CLAUDE.md'), '# my memory\n', 'utf-8')
  writeFileSync(join(profileDir, 'plugins', 'installed.json'), '{}', 'utf-8')
  writeFileSync(
    join(profileDir, '.credentials.json'),
    createCredentialsJson(ownerEmail, 'own-token'),
    'utf-8'
  )
  writeFileSync(
    join(homeDir, '.claude.json'),
    `${JSON.stringify({ oauthAccount: { accountUuid: 'own-account' }, projects: { '/repo': {} } })}\n`,
    'utf-8'
  )
  return homeDir
}

export function createWslManagedAuth(accountId: string, credentialsJson: string): string {
  const managedAuthPath = join(testState.userDataDir, 'claude-accounts', accountId, 'auth')
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, 'utf-8')
  writeFileSync(join(managedAuthPath, '.credentials.json'), credentialsJson, 'utf-8')
  writeFileSync(
    join(managedAuthPath, 'oauth-account.json'),
    `${JSON.stringify({ accountUuid: accountId })}\n`,
    'utf-8'
  )
  return managedAuthPath
}

export function createWslAccount(
  id: string,
  distro: string,
  managedAuthPath: string,
  email: string
): ClaudeManagedAccount {
  return {
    id,
    email,
    managedAuthPath,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    managedAuthRuntime: 'wsl',
    wslDistro: distro,
    wslLinuxAuthPath: `/home/alice/.local/share/orca/claude-accounts/${id}/auth`
  }
}

// Why: `wsl.exe -d <distro>` resolves distro names case-insensitively, so the stub does too.
export function lookupWslHome(distro: string): string | null {
  for (const [name, homeDir] of testState.wslHomeDirs) {
    if (name.toLowerCase() === distro.toLowerCase()) {
      return homeDir
    }
  }
  return null
}

export function mockWsl(
  overrides: {
    getWslHome?: (distro: string) => string | null
    wslUncFileExists?: (path: string) => boolean | null
  } = {}
): void {
  vi.doMock('../wsl', () => ({
    getDefaultWslDistro: () => 'Ubuntu',
    getWslHome: overrides.getWslHome ?? lookupWslHome,
    toWindowsWslPath: (value: string) => value,
    // Default matches a distro Orca cannot reach: inconclusive, never a licence to overwrite.
    wslUncFileExists: overrides.wslUncFileExists ?? ((): boolean | null => null)
  }))
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

export function listDistroSnapshotFiles(): string[] {
  const metadataDir = join(testState.userDataDir, 'claude-runtime-auth')
  return existsSync(metadataDir)
    ? readdirSync(metadataDir).filter((name) => name.startsWith('system-default-auth-wsl-'))
    : []
}
