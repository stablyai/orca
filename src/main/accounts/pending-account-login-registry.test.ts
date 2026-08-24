import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingAccountLoginRegistry } from './pending-account-login-registry'

describe('PendingAccountLoginRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accumulates output chunks onto the in-progress snapshot', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    registry.appendOutput('login-1', 'open this URL: ')
    registry.appendOutput('login-1', 'https://example.com/auth')

    expect(registry.get('login-1')).toEqual({
      loginId: 'login-1',
      provider: 'codex',
      status: 'in_progress',
      outputTail: 'open this URL: https://example.com/auth'
    })
  })

  it('resolves a successful login with its final state', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'claude')

    registry.complete('login-1', { id: 'account-1' })

    expect(registry.get('login-1')).toEqual({
      loginId: 'login-1',
      provider: 'claude',
      status: 'completed',
      outputTail: '',
      state: { id: 'account-1' }
    })
  })

  it('propagates a failed login error message', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    registry.fail('login-1', 'Codex login failed: denied')

    expect(registry.get('login-1')).toEqual({
      loginId: 'login-1',
      provider: 'codex',
      status: 'failed',
      outputTail: '',
      error: 'Codex login failed: denied'
    })
  })

  it('ignores updates once a login has already settled', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')
    registry.complete('login-1', { id: 'account-1' })

    registry.appendOutput('login-1', 'late chunk')
    registry.fail('login-1', 'too late')

    expect(registry.get('login-1')?.status).toBe('completed')
  })

  it('waitForUpdate resolves as soon as the login settles', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    const waitPromise = registry.waitForUpdate('login-1', 30_000)
    registry.complete('login-1', { id: 'account-1' })

    await expect(waitPromise).resolves.toBeUndefined()
  })

  it('waitForUpdate respects its timeout when no update arrives', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    const waitPromise = registry.waitForUpdate('login-1', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waitPromise).resolves.toBeUndefined()
    expect(registry.get('login-1')?.status).toBe('in_progress')
  })

  it('waitForUpdate resolves immediately when passed an already-aborted signal', async () => {
    // Why: the RPC long-poll layer passes the caller's AbortSignal through so
    // a disconnected client releases its waiter right away instead of holding
    // the long-poll open for the full timeout.
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')
    const controller = new AbortController()
    controller.abort()

    const waitPromise = registry.waitForUpdate('login-1', 30_000, controller.signal)

    // No timers advanced and no update posted — an already-aborted signal
    // must settle the wait without waiting out the timeout.
    await expect(waitPromise).resolves.toBeUndefined()
  })

  it('waitForUpdate resolves promptly when its signal aborts partway through the wait', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')
    const controller = new AbortController()

    const waitPromise = registry.waitForUpdate('login-1', 30_000, controller.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()

    // Resolves right away on abort, well before the 30s timeout would fire.
    await expect(waitPromise).resolves.toBeUndefined()
    expect(registry.get('login-1')?.status).toBe('in_progress')
  })

  it('reclaims a settled login after its TTL elapses', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')
    registry.complete('login-1', { id: 'account-1' })

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(registry.get('login-1')).toBeUndefined()
  })

  it('relays submitted input to the writer stored via setInputWriter', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'claude')
    const writeInput = vi.fn()

    registry.setInputWriter('login-1', writeInput)
    registry.submitInput('login-1', 'pasted-code')

    expect(writeInput).toHaveBeenCalledWith('pasted-code')
  })

  it('throws submitting input for an unknown loginId', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()

    expect(() => registry.submitInput('missing-login', 'pasted-code')).toThrow(
      'That account login no longer exists.'
    )
  })

  it('throws submitting input before any writer has been set', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'claude')

    expect(() => registry.submitInput('login-1', 'pasted-code')).toThrow(
      'This login is not waiting for input.'
    )
  })

  it('throws submitting input after the login has settled', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'claude')
    const writeInput = vi.fn()
    registry.setInputWriter('login-1', writeInput)
    registry.complete('login-1', { id: 'account-1' })

    expect(() => registry.submitInput('login-1', 'pasted-code')).toThrow(
      'That account login no longer exists.'
    )
    expect(writeInput).not.toHaveBeenCalled()
  })
})
