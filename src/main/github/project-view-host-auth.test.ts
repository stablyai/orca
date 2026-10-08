import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireMock,
  releaseMock,
  ghExecFileAsyncMock,
  hostAuthenticatedMock,
  noteRepositoryRateLimitSpendMock
} = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  hostAuthenticatedMock: vi.fn(),
  noteRepositoryRateLimitSpendMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../git/runner', () => ({
  extractExecError: vi.fn(() => ({ stdout: '', stderr: '' })),
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock
}))

vi.mock('./github-enterprise-repository', () => ({
  isGitHubHostAuthenticatedForGlobalCli: hostAuthenticatedMock
}))

import { runGraphql, runRest } from './project-view/internals'
import { _resetProjectViewCachesForTests, resolveProjectRef } from './project-view'

describe('project view host authentication boundary', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue(undefined)
    releaseMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    hostAuthenticatedMock.mockReset()
    noteRepositoryRateLimitSpendMock.mockReset()
    _resetProjectViewCachesForTests()
  })

  it('does not send GraphQL or REST requests to an unconfigured host', async () => {
    hostAuthenticatedMock.mockResolvedValue(false)

    const [graphql, rest] = await Promise.all([
      runGraphql('query { viewer { login } }', {}, { host: 'evil.example.test' }),
      runRest(['user'], undefined, 'core', { host: 'evil.example.test' })
    ])

    expect(graphql).toMatchObject({ ok: false, error: { type: 'auth_required' } })
    expect(rest).toMatchObject({ ok: false, error: { type: 'auth_required' } })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
    expect(noteRepositoryRateLimitSpendMock).not.toHaveBeenCalled()
  })

  it('routes a configured Enterprise request to its selected host', async () => {
    hostAuthenticatedMock.mockResolvedValue(true)
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: '{"data":{"viewer":{"login":"me"}}}',
      stderr: ''
    })

    await expect(
      runGraphql('query { viewer { login } }', {}, { host: 'github.corp.example' })
    ).resolves.toMatchObject({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(expect.any(Array), {
      encoding: 'utf-8',
      host: 'github.corp.example'
    })
  })

  it('keeps github.com fast and never probes it as Enterprise', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: '{"data":{"viewer":{"login":"me"}}}',
      stderr: ''
    })

    await expect(
      runGraphql('query { viewer { login } }', {}, { host: 'github.com' })
    ).resolves.toMatchObject({ ok: true })

    expect(hostAuthenticatedMock).not.toHaveBeenCalled()
  })

  it.each([
    { owner: 'acme-co', path: 'orgs', root: 'organization', ownerType: 'organization' },
    { owner: 'octocat', path: 'users', root: 'user', ownerType: 'user' },
    { owner: 'octocat_acme', path: 'users', root: 'user', ownerType: 'user' }
  ])(
    'resolves $owner on github.com instead of the ambient Enterprise host',
    async ({ owner, path, root, ownerType }) => {
      ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
        const query = args.find((arg) => arg.startsWith('query=')) ?? ''
        return query.includes('projectV2')
          ? {
              stdout: JSON.stringify({
                data: { [root]: { projectV2: { id: 'PVT_7', title: 'Roadmap' } } }
              }),
              stderr: ''
            }
          : {
              stdout: JSON.stringify({ data: { [root]: { login: owner } } }),
              stderr: ''
            }
      })

      await expect(
        resolveProjectRef({
          input: `https://github.com/${path}/${owner}/projects/7/views/2`,
          host: 'github.corp.example'
        })
      ).resolves.toEqual({
        ok: true,
        host: 'github.com',
        owner,
        ownerType,
        number: 7,
        viewNumber: 2,
        title: 'Roadmap'
      })

      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
      expect(
        ghExecFileAsyncMock.mock.calls.every(([, options]) => options.host === 'github.com')
      ).toBe(true)
      expect(hostAuthenticatedMock).not.toHaveBeenCalled()
      for (const [args] of ghExecFileAsyncMock.mock.calls) {
        expect(args).toContain(`owner=${owner}`)
        expect(args).toContainEqual(expect.stringContaining(`${root}(login:$owner)`))
      }
    }
  )

  it.each(['octocat', 'octocat_acme'])(
    'resolves user shorthand %s after an organization miss',
    async (owner) => {
      ghExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: '{"data":{"organization":null}}', stderr: '' })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ data: { user: { login: owner } } }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          stdout: '{"data":{"user":{"projectV2":{"id":"PVT_7","title":"Roadmap"}}}}',
          stderr: ''
        })

      await expect(resolveProjectRef({ input: `${owner}/7` })).resolves.toEqual({
        ok: true,
        owner,
        ownerType: 'user',
        number: 7,
        title: 'Roadmap',
        host: 'github.com'
      })
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
      const queries = ghExecFileAsyncMock.mock.calls.map(([args]) =>
        args.find((arg: string) => arg.startsWith('query='))
      )
      expect(queries[0]).toContain('organization(login:$owner)')
      expect(queries[1]).toContain('user(login:$owner)')
      expect(queries[2]).toContain('user(login:$owner)')
      for (const [args, options] of ghExecFileAsyncMock.mock.calls) {
        expect(args).toContain(`owner=${owner}`)
        expect(options.host).toBe('github.com')
      }
      expect(hostAuthenticatedMock).not.toHaveBeenCalled()
    }
  )

  it('rejects an unconfigured host even for a valid EMU owner', async () => {
    hostAuthenticatedMock.mockResolvedValue(false)
    await expect(
      resolveProjectRef({
        input: 'https://unconfigured.example/users/octocat_acme/projects/7',
        host: 'unconfigured.example'
      })
    ).resolves.toMatchObject({ ok: false, error: { type: 'auth_required' } })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it.each(['_acme/7', 'https://github.com/users/a%2Fb/projects/7'])(
    'rejects malformed owner input %s before requesting GitHub',
    async (input) => {
      await expect(resolveProjectRef({ input })).resolves.toMatchObject({
        ok: false,
        error: { type: 'validation_error' }
      })
      expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
      expect(acquireMock).not.toHaveBeenCalled()
    }
  )
})
