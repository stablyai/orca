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

  it('parses a single keyring login', () => {
    const text = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Token scopes: 'project', 'read:org', 'repo'
`
    const accounts = parseAuthStatus(text)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      user: 'alice',
      active: true,
      envToken: null,
      source: 'keyring'
    })
    expect(accounts[0].scopes).toContain('project')
  })

  it('detects GH_TOKEN env source', () => {
    const text = `github.com
  ✓ Logged in to github.com account bot (GH_TOKEN)
  - Active account: true
  - Token scopes: 'repo'
`
    const [acc] = parseAuthStatus(text)
    expect(acc.envToken).toBe('GH_TOKEN')
    expect(acc.source).toBe('env')
  })

  it('returns empty array when nothing is logged in', () => {
    expect(parseAuthStatus('You are not logged into any GitHub hosts.')).toEqual([])
  })

  it('parses multiple hosts in one output (github.com + GHES)', () => {
    const text = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Token scopes: 'read:org', 'repo'

ghe.acme.io
  ✓ Logged in to ghe.acme.io account bob (keyring)
  - Active account: true
  - Token scopes: 'project', 'repo'
`
    const accounts = parseAuthStatus(text)
    expect(accounts.map((a) => a.host)).toEqual(['github.com', 'ghe.acme.io'])
    expect(accounts.map((a) => a.user)).toEqual(['alice', 'bob'])
    expect(accounts[1].scopes).toContain('project')
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

  it('recovers host from the Logged-in line when the section header is missing', () => {
    // gh prints a colon after the host on some versions; we tolerate it,
    // but if the regex ever fails to match the header we still want
    // accounts attributed to the host from the inline message.
    const text = `  ✓ Logged in to github.acme.io account carol (keyring)
  - Active account: true
  - Token scopes: 'project'
`
    const accounts = parseAuthStatus(text)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].host).toBe('github.acme.io')
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
    // Why: bob's GHES token lacks project/read:org even though alice's
    // github.com token has them — advice must reflect the required host.
    expect(diag.missingScopes).toEqual(['project', 'read:org'])
  })

  it('keeps legacy host-less behavior byte-identical', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: TWO_HOST_STATUS, stderr: '' })

    const diag = await diagnoseGhAuth()

    expect(diag.requiredHost).toBeNull()
    expect(diag.requiredHostAuthenticated).toBeNull()
    expect(diag.activeAccount?.user).toBe('alice')
  })
})
