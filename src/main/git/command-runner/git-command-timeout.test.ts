import { describe, expect, it } from 'vitest'
import {
  GIT_READ_TIMEOUT_MS,
  GitCommandTimeoutError,
  gitCommandTimeoutMs
} from './git-command-timeout'

describe('gitCommandTimeoutMs', () => {
  it('pins the production read deadline', () => {
    expect(GIT_READ_TIMEOUT_MS).toBe(120_000)
  })

  it.each([
    [['status', '--porcelain=v2'], 120_000],
    [['show', 'HEAD:file'], 120_000],
    [['fetch', 'origin'], undefined],
    [['checkout', 'main'], undefined],
    [['unknown'], undefined]
  ] as const)('selects the fail-safe default for %j', (args, expected) => {
    expect(gitCommandTimeoutMs(args, undefined)).toBe(expected)
  })

  it('preserves every explicit timeout', () => {
    expect(gitCommandTimeoutMs(['status'], 7)).toBe(7)
    expect(gitCommandTimeoutMs(['fetch'], 7)).toBe(7)
  })

  it('provides a deterministic read-timeout seam', () => {
    expect(gitCommandTimeoutMs(['status'], undefined, 25)).toBe(25)
  })
})

describe('GitCommandTimeoutError', () => {
  it('is typed and retains its deadline', () => {
    const error = new GitCommandTimeoutError(25)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'GitCommandTimeoutError', timeoutMs: 25 })
  })
})
