import { describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({ ghExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))
import { diagnoseGhAuth, parseAuthStatus } from './auth-diagnose'

describe('parseAuthStatus', () => {
  it('parses an env-shadowed login alongside a keyring login (real gh output)', () => {
    const text = `github.com
  ✓ Logged in to github.com account nwparker (GITHUB_TOKEN)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account nwparker (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`
    const accounts = parseAuthStatus(text)
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      host: 'github.com',
      user: 'nwparker',
      active: true,
      envToken: 'GITHUB_TOKEN',
      source: 'env'
    })
    expect(accounts[0].scopes).toEqual(['gist', 'read:org', 'repo', 'workflow'])
    expect(accounts[1]).toMatchObject({
      active: false,
      envToken: null,
      source: 'keyring'
    })
  })

  it('parses a ported GHES auth-status section', () => {
    const text = `ghe.acme.io:8443
  ✓ Logged in to ghe.acme.io:8443 account bob (keyring)
  - Active account: true
  - Token scopes: 'project', 'repo'
`

    expect(parseAuthStatus(text)).toEqual([
      expect.objectContaining({ host: 'ghe.acme.io:8443', user: 'bob', active: true })
    ])
  })
})

describe('diagnoseGhAuth host scoping', () => {
  const TWO_HOST_STATUS = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Token scopes: 'project', 'read:org', 'repo'
ghe.acme.io
  ✓ Logged in to ghe.acme.io account bob (keyring)
  - Active account: true
  - Token scopes: 'repo'
`

  it('reports an unauthenticated required host and keeps scope advice host-scoped', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: TWO_HOST_STATUS, stderr: '' })

    const diag = await diagnoseGhAuth('github.other-corp.com')

    expect(diag.requiredHost).toBe('github.other-corp.com')
    expect(diag.requiredHostAuthenticated).toBe(false)
    expect(diag.activeAccount).toBeNull()
  })

  it("scopes the diagnosis to the required host's account", async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: TWO_HOST_STATUS, stderr: '' })

    const diag = await diagnoseGhAuth('GHE.Acme.IO')

    expect(diag.requiredHost).toBe('ghe.acme.io')
    expect(diag.requiredHostAuthenticated).toBe(true)
    expect(diag.activeAccount?.user).toBe('bob')
    expect(diag.missingScopes).toEqual(['project', 'read:org'])
  })
})
