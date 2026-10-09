import { beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeManagedCredentialsLocation } from './claude-managed-account-credentials'
import type { Mock } from 'vitest'

type CredentialSourceFixture = {
  location: ClaudeManagedCredentialsLocation
  readCredentials: Mock
  fetchUsage: Mock
}

const fixture = vi.hoisted((): CredentialSourceFixture => ({
  location: { kind: 'file', managedAuthPath: '/synthetic/auth' },
  readCredentials: vi.fn(),
  fetchUsage: vi.fn()
}))

vi.mock('./claude-managed-account-credentials', () => ({
  resolveClaudeManagedCredentialsLocation: () => fixture.location,
  readClaudeManagedCredentialsJson: fixture.readCredentials,
  writeClaudeManagedCredentialsJson: vi.fn()
}))
vi.mock('../claude-accounts/oauth-refresh', () => ({
  isOauthTokenExpiring: () => false,
  refreshClaudeOauthCredentials: vi.fn()
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: fixture.fetchUsage }))
vi.mock('./claude-managed-usage-panel', () => ({
  fetchClaudeManagedUsagePanelSupplement: vi.fn()
}))
vi.mock('./claude-pty', () => ({ fetchViaPty: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic' } }))

import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import { OAuthUsageError } from './claude-oauth-usage-error'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.readCredentials.mockResolvedValue(
    JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token', expiresAt: 1900000000000 } })
  )
  fixture.fetchUsage.mockRejectedValue(new OAuthUsageError('Synthetic wait', 429, true, 3600000))
})

it('identifies the managed scoped Keychain in a classified 429', async () => {
  fixture.location = { kind: 'keychain', accountId: 'A', managedAuthPath: '/synthetic/auth' }
  const result = await fetchInactiveClaudeAccountUsage({
    id: 'A',
    managedAuthPath: '/synthetic/auth'
  })

  expect(result.usageMetadata).toMatchObject({
    credentialSource: 'scoped-keychain',
    authProvenance: 'managed:A',
    failureKind: 'rate-limited'
  })
  expect(fixture.readCredentials).toHaveBeenCalledWith(fixture.location)
})

it.each(['host', 'wsl'] as const)(
  'keeps %s managed-file 429 metadata file-scoped',
  async (runtime) => {
    fixture.location = { kind: 'file', managedAuthPath: '/synthetic/auth' }
    const result = await fetchInactiveClaudeAccountUsage({
      id: 'A',
      managedAuthPath: '/synthetic/auth',
      managedAuthRuntime: runtime,
      wslDistro: runtime === 'wsl' ? 'SyntheticDistro' : null
    })

    expect(result.usageMetadata).toMatchObject({
      credentialSource: 'credentials-file',
      authProvenance: runtime === 'wsl' ? 'managed:A:wsl:SyntheticDistro' : 'managed:A',
      failureKind: 'rate-limited'
    })
    expect(fixture.readCredentials).toHaveBeenCalledWith(fixture.location)
  }
)
