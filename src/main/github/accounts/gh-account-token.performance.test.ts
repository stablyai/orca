import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { invalidateGhAccountTokenCache, resolveGhAccountToken } from './gh-account-token'
import type * as GhCapabilityState from './gh-capability-state'

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: vi.fn()
}))
vi.mock('./gh-capability-state', async (importOriginal) => ({
  ...(await importOriginal<typeof GhCapabilityState>()),
  getGhMultiAccountCapability: async () => 'supported'
}))

const binding = { host: 'github.com', user: 'alice' }
const gh = vi.mocked(ghExecFileAsync)

beforeEach(() => {
  invalidateGhAccountTokenCache()
  gh.mockReset()
})

describe('bound GitHub account token reads', () => {
  // #42562 established admission ownership through credential reads; a burst can share that child.
  it('shares a cold keyring read across concurrent commands for the same binding', async () => {
    const result = Promise.withResolvers<{ stdout: string; stderr: string }>()
    const started = Promise.withResolvers<void>()
    gh.mockImplementation(() => {
      started.resolve()
      return result.promise
    })

    const tokens = Promise.all(Array.from({ length: 8 }, () => resolveGhAccountToken(binding)))
    await started.promise
    result.resolve({ stdout: 'fixture-token\n', stderr: '' })

    expect(await tokens).toEqual(Array(8).fill('fixture-token'))
    expect(gh).toHaveBeenCalledTimes(1)
  })

  it('keeps the replacement token cached when an invalidated read settles last', async () => {
    const result = Promise.withResolvers<{ stdout: string; stderr: string }>()
    const started = Promise.withResolvers<void>()
    gh.mockImplementationOnce(() => {
      started.resolve()
      return result.promise
    })
    gh.mockResolvedValueOnce({ stdout: 'replacement-token\n', stderr: '' })

    const original = resolveGhAccountToken(binding)
    await started.promise
    invalidateGhAccountTokenCache(binding)
    await expect(resolveGhAccountToken(binding)).resolves.toBe('replacement-token')
    result.resolve({ stdout: 'original-token\n', stderr: '' })
    await original

    await expect(resolveGhAccountToken(binding)).resolves.toBe('replacement-token')
  })
})
