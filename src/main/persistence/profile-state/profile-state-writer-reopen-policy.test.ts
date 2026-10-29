import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProfileStateWriterReopenPolicy,
  reportTerminalReopenFailure
} from './profile-state-writer-reopen-policy'

const spawnFailure = Object.assign(new Error('spawn failed'), {
  code: 'profile-state-writer-unavailable'
})

describe('ProfileStateWriterReopenPolicy', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('retries the first failure at once, then backs off up to a minute', () => {
    let now = 0
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    expect(policy.recordFailure(spawnFailure)).toEqual({ retryInMs: 0 })
    expect(() => policy.admit()).not.toThrow()
    expect(policy.recordFailure(spawnFailure)).toEqual({ retryInMs: 1_000 })
    expect(() => policy.admit()).toThrow('spawn failed')
    now = 1_000
    expect(() => policy.admit()).not.toThrow()
    for (let failure = 0; failure < 10; failure += 1) {
      policy.recordFailure(spawnFailure)
    }
    now += 59_999
    expect(() => policy.admit()).toThrow('spawn failed')
    now += 1
    expect(() => policy.admit()).not.toThrow()
  })

  it('forgets the backoff once a reopen succeeds', () => {
    let now = 0
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    policy.recordFailure(spawnFailure)
    policy.recordFailure(spawnFailure)
    policy.recordSuccess()
    expect(() => policy.admit()).not.toThrow()
    expect(policy.recordFailure(spawnFailure)).toEqual({ retryInMs: 0 })
    expect(() => policy.admit()).not.toThrow()
  })

  it('lets one attempt through a backoff for a final flush', () => {
    const policy = new ProfileStateWriterReopenPolicy(() => 0)
    policy.recordFailure(spawnFailure)
    policy.recordFailure(spawnFailure)
    policy.bypassBackoffOnce()
    expect(() => policy.admit()).not.toThrow()
    expect(() => policy.admit()).toThrow('spawn failed')
  })

  it('drops a pending bypass once a reopen succeeds', () => {
    let now = 0
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    policy.recordFailure(spawnFailure)
    policy.bypassBackoffOnce()
    policy.recordSuccess()
    policy.recordFailure(spawnFailure)
    policy.recordFailure(spawnFailure)
    expect(() => policy.admit()).toThrow('spawn failed')
    now = 1_000
    expect(() => policy.admit()).not.toThrow()
  })

  it('reports a terminal failure even when the listener throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const conflict = Object.assign(new Error('changed'), {
      code: 'profile-state-revision-conflict'
    })
    const seen: Error[] = []
    expect(() =>
      reportTerminalReopenFailure((reported) => {
        seen.push(reported)
        throw new Error('listener broke')
      }, conflict)
    ).not.toThrow()
    expect(seen).toEqual([conflict])
    expect(error).toHaveBeenCalledWith(
      '[persistence] Could not report stopped saving:',
      expect.objectContaining({ message: 'listener broke' })
    )
  })

  it('keeps a revision conflict terminal', () => {
    const policy = new ProfileStateWriterReopenPolicy(() => 0)
    expect(policy.recordFailure({ code: 'profile-state-revision-conflict' })).toBeNull()
    expect(() => policy.admit()).not.toThrow()
  })

  it('counts every attempt and logs at most once per ten minutes', () => {
    let now = 0
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const policy = new ProfileStateWriterReopenPolicy(() => now)
    policy.recordAttempt()
    now = 9 * 60_000
    policy.recordAttempt()
    now = 10 * 60_000
    policy.recordAttempt()
    expect(policy.count).toBe(3)
    expect(info).toHaveBeenCalledTimes(2)
    info.mockRestore()
  })
})
