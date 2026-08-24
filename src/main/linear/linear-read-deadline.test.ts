import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const acquire = vi.fn()
const release = vi.fn()
const createSignalBoundLinearClient = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: (...args: unknown[]) => acquire(...args),
  release: (...args: unknown[]) => release(...args)
}))

vi.mock('./client', () => ({
  createSignalBoundLinearClient: (...args: unknown[]) => createSignalBoundLinearClient(...args)
}))

const entry = {
  workspace: { id: 'workspace-1' },
  apiKey: 'token'
} as LinearClientForWorkspace

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('Linear read deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('times out while queued and releases a late permit', async () => {
    const queuedPermit = deferred()
    const read = vi.fn()
    acquire.mockReturnValueOnce(queuedPermit.promise)
    const { readLinearBeforeDeadline } = await import('./linear-read-deadline')

    const resultPromise = readLinearBeforeDeadline(entry, Date.now() + 20_000, read)
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(resultPromise).resolves.toEqual({ completed: false, deadlineReached: true })
    expect(read).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    queuedPermit.resolve()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
  })

  it('settles a stalled in-flight read at the deadline', async () => {
    const stalled = new Promise<never>(() => undefined)
    const client = { client: { rawRequest: vi.fn() } }
    acquire.mockResolvedValueOnce(undefined)
    createSignalBoundLinearClient.mockReturnValueOnce(client)
    const { readLinearBeforeDeadline } = await import('./linear-read-deadline')

    const resultPromise = readLinearBeforeDeadline(entry, Date.now() + 20_000, () => stalled)
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(resultPromise).resolves.toEqual({ completed: false, deadlineReached: true })
    expect(createSignalBoundLinearClient).toHaveBeenCalledWith(entry, expect.any(AbortSignal))
    expect(release).toHaveBeenCalledTimes(1)
  })
})
