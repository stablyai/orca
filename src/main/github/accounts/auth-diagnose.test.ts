import { afterEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({ ghExecFileAsyncMock: vi.fn() }))

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { diagnoseGhAuth, parseAuthStatus } from './auth-diagnose'

function login(host: string, user: string, source = 'keyring'): string {
  return `${host}\n  ✓ Logged in to ${host} account ${user} (${source})\n  - Active account: true\n  - Token scopes: 'project', 'read:org', 'repo'\n`
}

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
})

describe('diagnoseGhAuth without a requested host', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    ghExecFileAsyncMock.mockReset()
  })

  it.each([
    {
      name: 'GH_HOST',
      ghHost: 'GHE.example.com',
      hosts: ['github.com', 'ghe.example.com'],
      expected: 'ghe'
    },
    { name: 'the only host', ghHost: '', hosts: ['ghe.example.com'], expected: 'ghe' },
    {
      name: 'github.com among several hosts',
      ghHost: '',
      hosts: ['ghe.example.com', 'github.com'],
      expected: 'dotcom'
    },
    {
      name: 'the only keyring host beside an env token',
      ghHost: '',
      hosts: ['ghe.example.com'],
      envTokenHost: 'github.com',
      expected: 'ghe'
    }
  ])("diagnoses gh's default host: $name", async ({ ghHost, hosts, envTokenHost, expected }) => {
    vi.stubEnv('GH_HOST', ghHost)
    const users: Record<string, string> = { 'github.com': 'dotcom', 'ghe.example.com': 'ghe' }
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: '',
      stderr:
        (envTokenHost ? login(envTokenHost, 'env', 'GH_TOKEN') : '') +
        hosts.map((host) => login(host, users[host])).join('')
    })

    const diag = await diagnoseGhAuth()

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(diag.activeAccount?.user).toBe(expected)
    expect(diag.requiredHost).toBeNull()
  })
})
