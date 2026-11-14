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

vi.mock('../execution/github-operation-slots', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../../git/command-runner/process-capture/exec-error', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractExecError: vi.fn(() => ({ stdout: '', stderr: '' }))
}))

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../api/rate-limit', () => ({
  rateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock
}))

vi.mock('../repositories/github-enterprise-repository', () => ({
  isGitHubHostAuthenticatedForGlobalCli: hostAuthenticatedMock
}))

import { runGraphql } from './project-graphql'
import { runRest } from './project-rest'
import { _resetProjectViewCachesForTests } from './project-view-cache'

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
})
