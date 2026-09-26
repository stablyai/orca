import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, getGhMultiAccountCapabilityMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getGhMultiAccountCapabilityMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import type * as GhCapabilityStateModule from './gh-capability-state'

vi.mock('./gh-capability-state', async (importOriginal) => {
  const actual = await importOriginal<typeof GhCapabilityStateModule>()
  return {
    ...actual,
    getGhMultiAccountCapability: getGhMultiAccountCapabilityMock
  }
})

import {
  buildBoundGhChildEnv,
  clearGhAccountTokenCacheForTests,
  createGhBoundAccountUnavailableError,
  invalidateGhAccountTokenCache,
  resolveGhAccountToken,
  stripAmbientGhTokenEnv
} from './gh-account-token'

describe('gh-account-token', () => {
  beforeEach(() => {
    clearGhAccountTokenCacheForTests()
    ghExecFileAsyncMock.mockReset()
    getGhMultiAccountCapabilityMock.mockReset()
    getGhMultiAccountCapabilityMock.mockResolvedValue('supported')
  })

  afterEach(() => {
    clearGhAccountTokenCacheForTests()
  })

  it('strips ambient token and host env vars', () => {
    const stripped = stripAmbientGhTokenEnv({
      PATH: '/bin',
      GH_TOKEN: 'ambient',
      GITHUB_TOKEN: 'ambient2',
      GH_ENTERPRISE_TOKEN: 'ent',
      GITHUB_ENTERPRISE_TOKEN: 'ent2',
      GH_HOST: 'github.example.com',
      GH_REPO: 'acme/widgets',
      KEEP: 'yes'
    })
    expect(stripped.GH_TOKEN).toBeUndefined()
    expect(stripped.GITHUB_TOKEN).toBeUndefined()
    expect(stripped.GH_ENTERPRISE_TOKEN).toBeUndefined()
    expect(stripped.GITHUB_ENTERPRISE_TOKEN).toBeUndefined()
    expect(stripped.GH_HOST).toBeUndefined()
    expect(stripped.GH_REPO).toBeUndefined()
    expect(stripped.KEEP).toBe('yes')
  })

  it('injects GH_TOKEN for github.com and GH_ENTERPRISE_TOKEN for GHES', () => {
    const cloud = buildBoundGhChildEnv({
      baseEnv: { PATH: '/bin', GH_TOKEN: 'ambient' },
      binding: { host: 'github.com', user: 'alice' },
      token: 'bound-token'
    })
    expect(cloud.GH_TOKEN).toBe('bound-token')
    expect(cloud.GITHUB_TOKEN).toBeUndefined()

    const enterprise = buildBoundGhChildEnv({
      baseEnv: { PATH: '/bin' },
      binding: { host: 'github.acme.com', user: 'alice' },
      token: 'ent-token',
      forWsl: true
    })
    expect(enterprise.GH_ENTERPRISE_TOKEN).toBe('ent-token')
    expect(enterprise.GH_TOKEN).toBeUndefined()
    expect(enterprise.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['GH_ENTERPRISE_TOKEN', 'GH_PROMPT_DISABLED'])
    )
  })

  it('resolves via gh auth token --user/--hostname and caches', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: 'tok\r\n', stderr: '' })
    await expect(resolveGhAccountToken({ host: 'github.com', user: 'Alice' })).resolves.toBe('tok')
    await expect(resolveGhAccountToken({ host: 'github.com', user: 'Alice' })).resolves.toBe('tok')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'token', '--user', 'Alice', '--hostname', 'github.com'],
      expect.objectContaining({ timeout: 10_000 })
    )
  })

  it('fails closed without ambient fallback and invalidates cache', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('nope'))
    await expect(
      resolveGhAccountToken({ host: 'github.com', user: 'Alice' })
    ).rejects.toMatchObject({ code: 'gh_bound_account_unavailable' })
    invalidateGhAccountTokenCache({ host: 'github.com', user: 'Alice' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: 'fresh', stderr: '' })
    await expect(resolveGhAccountToken({ host: 'github.com', user: 'Alice' })).resolves.toBe(
      'fresh'
    )
  })

  it('does not negative-cache transient resolve failures', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('gh timed out'), { code: 'ETIMEDOUT' })
    )
    await expect(
      resolveGhAccountToken({ host: 'github.com', user: 'Alice' })
    ).rejects.toMatchObject({ code: 'gh_bound_account_unavailable' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: 'recovered\n', stderr: '' })
    await expect(resolveGhAccountToken({ host: 'github.com', user: 'Alice' })).resolves.toBe(
      'recovered'
    )
  })

  it('surfaces multi-account unsupported from capability gate', async () => {
    getGhMultiAccountCapabilityMock.mockResolvedValue('unsupported')
    await expect(
      resolveGhAccountToken({ host: 'github.com', user: 'Alice' })
    ).rejects.toMatchObject({ code: 'gh_multi_account_unsupported' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('never puts the token into Error messages', () => {
    const error = createGhBoundAccountUnavailableError({ host: 'github.com', user: 'Alice' })
    expect(error.message).not.toContain('gho_')
    expect(error.message).toContain('Alice@github.com')
  })
})
