import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeKeychain from '../claude-accounts/keychain'

const boundary = vi.hoisted(() => ({
  strictKeychain: vi.fn(),
  password: vi.fn(),
  readFile: vi.fn(),
  exists: vi.fn(),
  readSync: vi.fn(),
  desktop: vi.fn(),
  running: vi.fn(),
  accountPreparation: vi.fn(),
  usage: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ readFile: boundary.readFile }))
vi.mock('node:fs', () => ({
  existsSync: boundary.exists,
  readFileSync: boundary.readSync,
  realpathSync: () => '/canonical/profile',
  lstatSync: vi.fn()
}))
vi.mock('../macos-keychain/generic-password', () => ({ readKeychainPassword: boundary.password }))
vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: boundary.strictKeychain
}))
vi.mock('../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readCursorDesktopProfile: boundary.desktop
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: boundary.running
}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({ userConfigDir: () => '/profile' }),
  getClaudeWslProfileRouter: () => ({ accountUsagePreparation: boundary.accountPreparation })
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: boundary.usage }))

import { readClaudeOAuthCredentials } from './claude-oauth-credentials'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import { readCursorAuthSession } from './cursor-auth'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  boundary.strictKeychain.mockResolvedValue(null)
  boundary.password.mockResolvedValue(null)
  boundary.readFile.mockResolvedValue(
    JSON.stringify({ claudeAiOauth: { accessToken: 'placeholder' } })
  )
  boundary.exists.mockReturnValue(false)
  boundary.desktop.mockResolvedValue({ status: 'missing' })
  boundary.running.mockResolvedValue(['guest'])
  boundary.accountPreparation.mockResolvedValue({
    configDir: '/profile',
    envPatch: {},
    provenance: 'profile:test'
  })
})
afterEach(() => {
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

describe('usage credential cancellation between asynchronous stages', () => {
  it('prevents legacy Keychain and file fallback after the scoped read is cancelled', async () => {
    const read = Promise.withResolvers<string | null>()
    boundary.strictKeychain.mockReturnValueOnce(read.promise)
    const controller = new AbortController()
    const pending = readClaudeOAuthCredentials({
      credentialsFileConfigDir: '/profile',
      keychainConfigDir: '/profile',
      unsuffixedKeychainFallback: true,
      signal: controller.signal
    })
    controller.abort()
    read.resolve(null)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(boundary.strictKeychain).toHaveBeenCalledTimes(1)
    expect(boundary.readFile).not.toHaveBeenCalled()
  })

  it('prevents canonical Keychain alias lookup after the first spelling is cancelled', async () => {
    const { readActiveClaudeKeychainCredentialsStrict } = await vi.importActual<
      typeof ClaudeKeychain
    >('../claude-accounts/keychain')
    const controller = new AbortController()
    boundary.password.mockImplementationOnce(async () => {
      controller.abort()
      return null
    })
    await expect(
      readActiveClaudeKeychainCredentialsStrict('/lexical/profile', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(boundary.password).toHaveBeenCalledTimes(1)
  })

  it('threads the active usage signal into credential admission', async () => {
    const read = Promise.withResolvers<string | null>()
    boundary.strictKeychain.mockReturnValueOnce(read.promise)
    const controller = new AbortController()
    const pending = fetchActiveClaudeRateLimits({
      signal: controller.signal,
      authPreparation: {
        configDir: '/profile',
        envPatch: { CLAUDE_CONFIG_DIR: '/profile' },
        provenance: 'profile:test'
      }
    })
    controller.abort()
    read.resolve(null)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(boundary.readFile).not.toHaveBeenCalled()
    expect(boundary.usage).not.toHaveBeenCalled()
  })

  it('prevents inactive WSL router preparation after the running-distro probe is cancelled', async () => {
    const probe = Promise.withResolvers<string[]>()
    boundary.running.mockReturnValueOnce(probe.promise)
    const controller = new AbortController()
    const pending = fetchInactiveClaudeAccountUsage(
      { id: 'test', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' },
      { signal: controller.signal }
    )
    controller.abort()
    probe.resolve(['guest'])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(boundary.accountPreparation).not.toHaveBeenCalled()
  })

  it('prevents Cursor file and desktop lookup after the Keychain read is cancelled', async () => {
    const read = Promise.withResolvers<string | null>()
    boundary.password.mockReturnValueOnce(read.promise)
    const controller = new AbortController()
    const pending = readCursorAuthSession({
      cliAuthPath: '/cursor/auth',
      cliConfigPath: '/cursor/config',
      desktopStateDbPath: '/cursor/state',
      signal: controller.signal
    })
    controller.abort()
    read.resolve(null)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(boundary.exists).not.toHaveBeenCalled()
    expect(boundary.readSync).not.toHaveBeenCalled()
    expect(boundary.desktop).not.toHaveBeenCalled()
  })

  it('rejects a late Cursor desktop worker result after cancellation', async () => {
    const read = Promise.withResolvers<{ status: 'missing' }>()
    boundary.desktop.mockReturnValueOnce(read.promise)
    const controller = new AbortController()
    const pending = readCursorAuthSession({ signal: controller.signal })
    await vi.waitFor(() => {
      expect(boundary.desktop).toHaveBeenCalledTimes(1)
    })
    controller.abort()
    read.resolve({ status: 'missing' })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
