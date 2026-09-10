import { invalidateLinearAccountReads } from './linear-account-read-lifetime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueListLifetime } from './mcp-issue-list-lifetime'
import { linearError } from './issue-context-errors'
import { acquire, release } from './linear-request-concurrency'
import { readFetchResponseBytesWithinLimit } from '../../shared/fetch-response-body'
vi.mock('./linear-token-store', async () => {
  const { invalidateLinearAccountReads } = await import('./linear-account-read-lifetime')
  return { clearToken: vi.fn((id: string) => invalidateLinearAccountReads(id)) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

describe('Linear list lease lifetime', () => {
  it('removes an aborted queued waiter without admitting it later', async () => {
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    const abort = new AbortController()
    const queued = acquire(abort.signal)
    const observed = expect(queued).rejects.toBe('cancelled')
    abort.abort('cancelled')
    await observed
    release()
    release()
    release()
    release()
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    release()
    release()
    release()
    release()
  })
  it.each(['read', 'cancel'] as const)(
    'holds list reservation and provider lease until stuck %s settles',
    async (stuck) => {
      vi.useFakeTimers()
      const read = deferred<ReadableStreamReadResult<Uint8Array>>()
      const cancel = deferred<void>()
      const reader = {
        read: () => read.promise,
        cancel: () => cancel.promise,
        releaseLock: vi.fn()
      }
      const response = {
        headers: new Headers(),
        body: { getReader: () => reader }
      } as unknown as Response
      const owner = new IssueListLifetime(undefined, 10)
      const listing = owner.read('fixture', (signal) =>
        readFetchResponseBytesWithinLimit(response, 1024, signal)
      )
      const observed = expect(listing).rejects.toMatchObject({ code: 'linear_timeout' })
      await vi.advanceTimersByTimeAsync(11)
      await observed
      owner.finish()
      const rest = Array.from({ length: 27 }, () => new IssueListLifetime())
      expect(() => new IssueListLifetime()).toThrow('capacity')
      await Promise.all([acquire(), acquire(), acquire()])
      let fifthAdmitted = false
      const fifth = acquire().then(() => {
        fifthAdmitted = true
      })
      if (stuck === 'read') {
        cancel.resolve()
      } else {
        read.resolve({ done: true, value: undefined })
      }
      await vi.advanceTimersByTimeAsync(1)
      expect(fifthAdmitted).toBe(false)
      expect(() => new IssueListLifetime()).toThrow('capacity')
      read.resolve({ done: true, value: undefined })
      cancel.resolve()
      await fifth
      const recovered = new IssueListLifetime()
      recovered.finish()
      rest.forEach((item) => item.finish())
      release()
      release()
      release()
      release()
      expect(reader.releaseLock).toHaveBeenCalledOnce()
    }
  )
  it('cannot start a second page while an invalidated read still owns cleanup', async () => {
    const owner = new IssueListLifetime()
    const held = deferred<string>()
    const pending = owner.read('fixture', () => held.promise)
    const observed = expect(pending).rejects.toMatchObject({ code: 'linear_list_stale_recovery' })
    await Promise.resolve()
    invalidateLinearAccountReads('fixture')
    await observed
    expect(owner.cleanupPending).toBe(true)
    const next = vi.fn(async () => 'next')
    await expect(owner.read('healthy', next)).rejects.toMatchObject({
      code: 'linear_list_capacity'
    })
    expect(next).not.toHaveBeenCalled()
    owner.finish()
    held.resolve('late page')
    await vi.waitFor(() => expect(owner.cleanupPending).toBe(false))
  })
  it('keeps auth expiration typed when clearing tokens invalidates sibling reads', async () => {
    const owner = new IssueListLifetime()
    try {
      await expect(
        owner.read('fixture', async () => {
          throw linearError('linear_auth_expired', 'Linear authentication expired.')
        })
      ).rejects.toMatchObject({ code: 'linear_auth_expired' })
    } finally {
      owner.finish()
    }
  })
  it('holds a completed result until delivery handoff', async () => {
    const owners = Array.from({ length: 28 }, () => new IssueListLifetime())
    expect(await owners[0].read('fixture', async () => 'complete')).toBe('complete')
    expect(() => new IssueListLifetime()).toThrow('capacity')
    owners[0].finish()
    const next = new IssueListLifetime()
    next.finish()
    owners.forEach((owner) => owner.finish())
  })
})
