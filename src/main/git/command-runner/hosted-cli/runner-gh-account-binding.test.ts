import type * as GhAccountTokenModule from '../../../github/accounts/gh-account-token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  spawnMock,
  resolveGhAccountTokenMock,
  buildBoundGhChildEnvMock,
  createGhBoundAccountHostMismatchErrorMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveGhAccountTokenMock: vi.fn(),
  buildBoundGhChildEnvMock: vi.fn(),
  createGhBoundAccountHostMismatchErrorMock: vi.fn(
    (binding: { host: string; user: string }, host?: string) =>
      Object.assign(
        new Error(
          host
            ? `host mismatch ${binding.host} vs ${host}`
            : `host required for ${binding.user}@${binding.host}`
        ),
        { code: 'gh_bound_account_host_mismatch', stderr: 'host mismatch' }
      )
  )
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))

vi.mock('../../../github/accounts/gh-account-token', async (importOriginal) => {
  const actual = await importOriginal<typeof GhAccountTokenModule>()
  return {
    ...actual,
    resolveGhAccountToken: resolveGhAccountTokenMock,
    buildBoundGhChildEnv: buildBoundGhChildEnvMock,
    createGhBoundAccountHostMismatchError: createGhBoundAccountHostMismatchErrorMock
  }
})

import { ghExecFileAsync } from './gh-exec-file'
import { _resetGhRateLimitBreaker, recordGhPrimaryRateLimit } from './gh-rate-limit-breaker'

/** Spawns a child that settles with `stdout`, capturing the env the runner handed it. */

describe('ghExecFileAsync account binding', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    resolveGhAccountTokenMock.mockReset()
    buildBoundGhChildEnvMock.mockReset()
    createGhBoundAccountHostMismatchErrorMock.mockClear()
    _resetGhRateLimitBreaker()
    resolveGhAccountTokenMock.mockResolvedValue('bound-token')
    buildBoundGhChildEnvMock.mockImplementation(
      ({
        baseEnv,
        binding,
        token
      }: {
        baseEnv?: NodeJS.ProcessEnv
        binding: { host: string; user: string }
        token: string
      }) => ({
        ...(baseEnv ?? process.env),
        GH_PROMPT_DISABLED: '1',
        GH_TOKEN: binding.host === 'github.com' ? token : undefined,
        GH_ENTERPRISE_TOKEN: binding.host === 'github.com' ? undefined : token
      })
    )
  })

  afterEach(() => {
    _resetGhRateLimitBreaker()
  })

  it('fails closed when argv host signals disagree with the binding', async () => {
    await expect(
      ghExecFileAsync(['pr', 'list', '--repo', 'github.acme.com/a/b'], {
        host: 'github.com',
        ghAccount: { host: 'github.com', user: 'Alice' }
      })
    ).rejects.toMatchObject({ code: 'gh_bound_account_host_mismatch' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(['-Rgithub.acme.com/a/b', '-R=github.acme.com/a/b'])(
    'fails closed for the attached %s host form',
    async (attached) => {
      await expect(
        ghExecFileAsync(['pr', 'list', attached], {
          host: 'github.com',
          ghAccount: { host: 'github.com', user: 'Alice' }
        })
      ).rejects.toMatchObject({ code: 'gh_bound_account_host_mismatch' })
      expect(spawnMock).not.toHaveBeenCalled()
    }
  )

  it('fails a bound API call fast on a blocked bucket without resolving a token', async () => {
    recordGhPrimaryRateLimit('core', Date.now() + 60_000, 'native:github.com')

    await expect(
      ghExecFileAsync(['api', 'user'], {
        host: 'github.com',
        ghAccount: { host: 'github.com', user: 'Alice' }
      })
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })
    expect(resolveGhAccountTokenMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
