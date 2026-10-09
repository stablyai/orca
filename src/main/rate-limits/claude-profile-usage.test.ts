import type * as Keychain from '../claude-accounts/keychain'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ keychain: vi.fn(), usage: vi.fn(), keychainService: vi.fn() }))
vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: calls.keychainService
}))
vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: calls.keychain
}))
const profileRouter = vi.hoisted((): { userConfigDir?: string } => ({}))
const wslRouter = vi.hoisted(() => ({ accountUsagePreparation: vi.fn() }))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    profileRouter.userConfigDir ? { userConfigDir: () => profileRouter.userConfigDir } : undefined,
  getClaudeWslProfileRouter: () => wslRouter
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: calls.usage }))
const runningDistros = vi.hoisted(() => ({
  filter: vi.fn(async (paths: readonly string[]) => [...paths])
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: runningDistros.filter
}))
vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: () => {
    throw new Error('Usage must not launch a process')
  },
  runProcess: () => {
    throw new Error('Usage must not launch a process')
  }
}))
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import { OAuthUsageError } from './claude-oauth-usage-error'
import { CLAUDE_PROFILE_MISSING_MESSAGE } from '../../shared/claude-profile-routing'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function profile() {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-'))
  roots.push(home)
  calls.keychain.mockResolvedValue(null)
  const options = {
    authPreparation: {
      configDir: home,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      provenance: 'profile:fake'
    }
  }
  return { home, options }
}
function systemDefault() {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-default-'))
  roots.push(home)
  calls.keychain.mockResolvedValue(null)
  return {
    home,
    options: {
      authPreparation: { configDir: home, envPatch: {}, provenance: 'system' }
    }
  }
}
it('lets the server decide a locally expired token and never refreshes it', async () => {
  const f = profile()
  const file = join(f.home, '.credentials.json')
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'expired-fake', refreshToken: 'must-not-be-used', expiresAt: 1 }
    })
  )
  vi.stubGlobal('fetch', () => {
    throw new Error('No refresh endpoint')
  })
  calls.usage.mockRejectedValue(new OAuthUsageError('Invalid OAuth token.', 401, true, null))
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    status: 'error',
    error: 'Claude usage has expired. Start Claude in this account to refresh it.',
    usageMetadata: { failureKind: 'stale-token' }
  })
  expect(calls.usage.mock.calls.map(([token]) => token)).toEqual(['expired-fake'])
  const system = systemDefault()
  writeFileSync(
    join(system.home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'expired-default', expiresAt: 1 } })
  )
  calls.usage.mockResolvedValueOnce({ provider: 'claude', status: 'ok' })
  expect(await fetchActiveClaudeRateLimits(system.options)).toMatchObject({ status: 'ok' })
  expect(await fetchActiveClaudeRateLimits(system.options)).toMatchObject({
    error: 'Claude usage updates the next time Claude runs.',
    usageMetadata: { failureKind: 'stale-token' }
  })
})
it('reads only the requested scoped Keychain, with no unsuffixed fallback', async () => {
  const f = profile()
  await readClaudeOAuthCredentials({ credentialsFileConfigDir: f.home, keychainConfigDir: f.home })
  if (process.platform === 'darwin') {
    expect(calls.keychain.mock.calls).toEqual([[f.home]])
  } else {
    expect(calls.keychain).not.toHaveBeenCalled()
  }
})
it('distinguishes missing, malformed and inaccessible credential observations', async () => {
  const f = profile()
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    usageMetadata: { failureKind: 'missing-credentials' }
  })
  writeFileSync(join(f.home, '.credentials.json'), '{')
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    usageMetadata: { failureKind: 'keychain-unavailable' }
  })
})
it('reports an unreadable selected account before any credential read and requests no hidden recovery', async () => {
  const f = profile()
  expect(
    await fetchActiveClaudeRateLimits({
      authPreparation: { ...f.options.authPreparation, usageError: CLAUDE_PROFILE_MISSING_MESSAGE }
    })
  ).toMatchObject({ status: 'error', usageMetadata: { failureKind: 'missing-credentials' } })
  expect(calls.keychain).not.toHaveBeenCalled()
  writeFileSync(
    join(f.home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } })
  )
  calls.usage.mockRejectedValue(new Error('network unavailable'))
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({ status: 'error' })
  expect(calls.usage).toHaveBeenCalledTimes(1)
})

it('strict Keychain lookup never falls back to the unsuffixed service', async () => {
  const f = profile()
  calls.keychainService.mockResolvedValue(null)
  const actual = await vi.importActual<typeof Keychain>('../claude-accounts/keychain')
  await actual.readActiveClaudeKeychainCredentialsStrict(f.home)
  expect(calls.keychainService).toHaveBeenCalled()
  for (const [service] of calls.keychainService.mock.calls) {
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  }
  calls.keychainService.mockClear()
  calls.keychainService.mockRejectedValue(new Error('locked'))
  await expect(actual.readActiveClaudeKeychainCredentialsStrict(f.home)).rejects.toThrow('locked')
  expect(calls.keychainService).toHaveBeenCalledTimes(1)
})
it('treats an unreadable credential file as unavailable, not a missing login', async () => {
  const f = profile()
  mkdirSync(join(f.home, '.credentials.json'))
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    usageMetadata: { failureKind: 'keychain-unavailable' }
  })
})
it('hides Claude usage for System Default with no Claude login, instead of asking to sign in again', async () => {
  const f = systemDefault()
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials' }
  })
  expect(await fetchActiveClaudeRateLimits(profile().options)).toMatchObject({
    status: 'error',
    error: 'Sign in again to use this account.'
  })
})
it("keeps a 429's Retry-After and rate-limit message so polling waits it out", async () => {
  const f = profile()
  writeFileSync(
    join(f.home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } })
  )
  const message = 'Claude usage is rate limited right now.'
  calls.usage.mockRejectedValueOnce(new OAuthUsageError(message, 429, true, 3_000_000))
  const before = Date.now()
  const limited = await fetchActiveClaudeRateLimits(f.options)
  expect(limited).toMatchObject({
    status: 'error',
    error: message,
    usageMetadata: { failureKind: 'rate-limited' }
  })
  expect(limited.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 3_000_000)
  expect(limited.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 3_000_000)
  calls.usage.mockRejectedValueOnce(new OAuthUsageError(message, 429, true, null))
  expect((await fetchActiveClaudeRateLimits(f.options)).usageMetadata?.retryAtMs).toBeUndefined()
})
it("reads System default's own CLAUDE_CONFIG_DIR Keychain item before the unsuffixed one", async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-usage-inherited-'))
  roots.push(root)
  const inherited = join(root, 'own-claude-config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', inherited)
  try {
    calls.keychain.mockResolvedValue(null)
    await readClaudeOAuthCredentials(
      resolveClaudeOAuthCredentialReadOptions({
        configDir: inherited,
        envPatch: {},
        provenance: 'system'
      })
    )
    expect(calls.keychain.mock.calls).toEqual(
      process.platform === 'darwin' ? [[inherited], [undefined]] : []
    )
  } finally {
    vi.unstubAllEnvs()
  }
  const managed = profile()
  calls.keychain.mockClear()
  await fetchActiveClaudeRateLimits(managed.options)
  expect(calls.keychain.mock.calls).toEqual(process.platform === 'darwin' ? [[managed.home]] : [])
})
it("names System default's Keychain item from the login shell's CLAUDE_CONFIG_DIR a Dock launch lacks", () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  profileRouter.userConfigDir = '/shell/claude-config'
  try {
    expect(
      resolveClaudeOAuthCredentialReadOptions({
        configDir: '/shell/claude-config',
        envPatch: {},
        provenance: 'system'
      })?.keychainConfigDir
    ).toBe('/shell/claude-config')
  } finally {
    profileRouter.userConfigDir = undefined
    vi.unstubAllEnvs()
  }
})
it('reports a host problem as unavailable usage, never as a signed-out account', async () => {
  const f = profile()
  expect(
    await fetchActiveClaudeRateLimits({
      authPreparation: {
        ...f.options.authPreparation,
        usageError: 'Could not read the home folder of WSL distro Ubuntu.'
      }
    })
  ).toMatchObject({ status: 'error', usageMetadata: { failureKind: 'usage-unavailable' } })
})
it('reads an inactive WSL account where the WSL router says its launches would run', async () => {
  const { fetchInactiveClaudeAccountUsage } = await import('./claude-managed-account-usage')
  const authPreparation = {
    configDir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude',
    runtime: 'wsl' as const,
    wslDistro: 'Ubuntu',
    envPatch: {},
    provenance: 'wsl:Ubuntu:system'
  }
  wslRouter.accountUsagePreparation.mockResolvedValueOnce(authPreparation)
  calls.usage.mockResolvedValueOnce({ five_hour: null, seven_day: null })
  await fetchInactiveClaudeAccountUsage({
    id: 'acct',
    managedAuthRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxAuthPath: '/home/u/.local/share/orca/claude-accounts/acct/auth'
  })
  expect(wslRouter.accountUsagePreparation).toHaveBeenCalledWith('Ubuntu', 'acct')
})
it('does not read an inactive WSL account through a stopped distro', async () => {
  const { fetchInactiveClaudeAccountUsage } = await import('./claude-managed-account-usage')
  runningDistros.filter.mockResolvedValueOnce([])
  wslRouter.accountUsagePreparation.mockClear()
  const result = await fetchInactiveClaudeAccountUsage({
    id: 'acct',
    managedAuthRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxAuthPath: '/home/u/.local/share/orca/claude-profiles/acct/home'
  })
  expect(runningDistros.filter).toHaveBeenCalledWith(['\\\\wsl.localhost\\Ubuntu\\'], {
    requireConfirmed: true
  })
  expect(result).toMatchObject({ usageMetadata: { failureKind: 'usage-unavailable' } })
  expect(wslRouter.accountUsagePreparation).not.toHaveBeenCalled()
  expect(calls.keychain).not.toHaveBeenCalled()
})
