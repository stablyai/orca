import { describe, expect, it } from 'vitest'
import { parseAuthStatus } from './auth-diagnose'

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
})
