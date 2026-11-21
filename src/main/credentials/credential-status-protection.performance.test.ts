import { expect, it, vi } from 'vitest'
import { getStatus as linearStatus } from '../linear/accounts/linear-account-client'
import { getStatus as jiraStatus } from '../jira/client'

const fixture = vi.hoisted(() => ({ plaintextAt: 0, linear: vi.fn(), jira: vi.fn() }))
const count = 100
vi.mock('../linear/accounts/linear-workspace-registry', () => ({
  getWorkspaceState: async () => ({
    workspaces: Array.from({ length: count }, (_, index) => ({ id: String(index) }))
  }),
  getCredentialError: async () => undefined
}))
vi.mock('../linear/accounts/linear-token-store', () => ({
  getWorkspaceTokenProtection: fixture.linear
}))
vi.mock('../jira/site-credential-store', () => ({
  getSiteFile: async () => ({
    sites: Array.from({ length: count }, (_, index) => ({ id: String(index) }))
  }),
  hasStoredToken: async () => true,
  getCredentialError: async () => undefined,
  getSiteTokenProtection: fixture.jira
}))

it('stops protection reads at the first plaintext credential', async () => {
  for (const [status, protection] of [
    [linearStatus, fixture.linear],
    [jiraStatus, fixture.jira]
  ] as const) {
    protection
      .mockReset()
      .mockImplementation(async (id: string) =>
        Number(id) === fixture.plaintextAt ? 'plaintext' : null
      )
    fixture.plaintextAt = 0
    expect((await status()).credentialProtection).toBe('plaintext')
    expect(protection).toHaveBeenCalledTimes(1)
    protection.mockClear()
    fixture.plaintextAt = -1
    expect((await status()).credentialProtection).toBe(null)
    expect(protection).toHaveBeenCalledTimes(count)
    protection.mockClear()
    fixture.plaintextAt = count - 1
    expect((await status()).credentialProtection).toBe('plaintext')
    expect(protection).toHaveBeenCalledTimes(count)
  }
})
