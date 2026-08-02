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

  it('uses a pasted github.com URL instead of the ambient Enterprise host', async () => {
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      return query.includes('projectV2')
        ? {
            stdout: JSON.stringify({
              data: { organization: { projectV2: { id: 'PVT_7', title: 'Roadmap' } } }
            }),
            stderr: ''
          }
        : {
            stdout: JSON.stringify({ data: { organization: { login: 'acme' } } }),
            stderr: ''
          }
    })

    await expect(
      resolveProjectRef({
        input: 'https://github.com/orgs/acme/projects/7',
        host: 'github.corp.example'
      })
    ).resolves.toMatchObject({ ok: true, host: 'github.com' })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(
      ghExecFileAsyncMock.mock.calls.every(([, options]) => options.host === 'github.com')
    ).toBe(true)
    expect(hostAuthenticatedMock).not.toHaveBeenCalled()
  })
})
