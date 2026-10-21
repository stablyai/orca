import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as ClaudeOAuthCredentials from './claude-oauth-credentials'

type CredentialSourceFixture = {
  source: ClaudeOAuthCredentials.ClaudeOAuthCredentialSource
  readCredentials: ReturnType<typeof vi.fn>
  fetchUsage: ReturnType<typeof vi.fn>
  hostPreparation: ReturnType<typeof vi.fn>
  wslPreparation: ReturnType<typeof vi.fn>
}

const fixture = vi.hoisted((): CredentialSourceFixture => ({
  source: 'credentials-file',
  readCredentials: vi.fn(),
  fetchUsage: vi.fn(),
  hostPreparation: vi.fn(),
  wslPreparation: vi.fn()
}))

vi.mock('./claude-oauth-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeOAuthCredentials>()),
  readClaudeOAuthCredentials: fixture.readCredentials
}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({ accountUsagePreparation: fixture.hostPreparation }),
  getClaudeWslProfileRouter: () => ({ accountUsagePreparation: fixture.wslPreparation })
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: async (paths: readonly string[]) => [...paths]
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: fixture.fetchUsage }))

import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import { OAuthUsageError } from './claude-oauth-usage-error'

const configDir = join(tmpdir(), 'synthetic-claude-profile-A')
const now = 1800000000000

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  fixture.readCredentials.mockImplementation(async () => ({
    token: 'synthetic-token',
    hasRefreshableCredentials: false,
    source: fixture.source
  }))
  fixture.fetchUsage.mockRejectedValue(new OAuthUsageError('Synthetic wait', 429, true, 3600000))
})

afterEach(() => vi.restoreAllMocks())

it.each([
  ['host', 'scoped-keychain'],
  ['host', 'credentials-file'],
  ['wsl', 'credentials-file']
] as const)('keeps %s profile 429 metadata from %s', async (runtime, source) => {
  fixture.source = source
  const provenance = runtime === 'wsl' ? 'wsl:SyntheticDistro:profile:A' : 'profile:A'
  const preparation = {
    configDir,
    envPatch: { CLAUDE_CONFIG_DIR: configDir },
    provenance
  }
  fixture.hostPreparation.mockReturnValue(preparation)
  fixture.wslPreparation.mockResolvedValue(preparation)
  const result = await fetchInactiveClaudeAccountUsage({
    id: 'A',
    managedAuthRuntime: runtime,
    wslDistro: runtime === 'wsl' ? 'SyntheticDistro' : null
  })

  expect(result.usageMetadata).toMatchObject({
    credentialSource: source,
    authProvenance: provenance,
    failureKind: 'rate-limited',
    retryAtMs: now + 3600000
  })
  expect(fixture.readCredentials).toHaveBeenCalledWith({
    credentialsFileConfigDir: configDir,
    keychainConfigDir: configDir,
    unsuffixedKeychainFallback: false
  })
  expect(fixture.fetchUsage).toHaveBeenCalledWith('synthetic-token', undefined)
  if (runtime === 'wsl') {
    expect(fixture.wslPreparation).toHaveBeenCalledWith('SyntheticDistro', 'A')
    expect(fixture.hostPreparation).not.toHaveBeenCalled()
  } else {
    expect(fixture.hostPreparation).toHaveBeenCalledWith('A')
    expect(fixture.wslPreparation).not.toHaveBeenCalled()
  }
})
