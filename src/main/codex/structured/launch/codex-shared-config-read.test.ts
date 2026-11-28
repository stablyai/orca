import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharingCodexConfigReads } from './codex-shared-config-read'

afterEach(() => {
  vi.useRealTimers()
})

function heldConnection() {
  let answer: (value: unknown) => void = () => {}
  const request = vi.fn((method: string) =>
    method === 'config/read'
      ? new Promise<unknown>((resolve) => {
          answer = resolve
        })
      : Promise.resolve(`${method} done`)
  )
  return { connection: { request }, answer: (value: unknown) => answer(value) }
}

describe('sharingCodexConfigReads', () => {
  it('reads once for steps asking the same config together', async () => {
    const { connection, answer } = heldConnection()
    const shared = sharingCodexConfigReads(connection)
    const first = shared.request('config/read', { cwd: '/work' }, { timeoutMs: 2_000 })
    const second = shared.request('config/read', { cwd: '/work' }, { timeoutMs: 10_000 })
    answer({ config: { mcp_servers: {} } })
    expect(await first).toEqual({ config: { mcp_servers: {} } })
    expect(await second).toEqual({ config: { mcp_servers: {} } })
    expect(connection.request).toHaveBeenCalledTimes(1)
    // The shared read waits as long as the longest step would.
    expect(connection.request).toHaveBeenCalledWith(
      'config/read',
      { cwd: '/work' },
      { timeoutMs: 10_000 }
    )
  })

  it('keeps each step’s own deadline', async () => {
    vi.useFakeTimers()
    const { connection, answer } = heldConnection()
    const shared = sharingCodexConfigReads(connection)
    const short = shared.request('config/read', { cwd: '/work' }, { timeoutMs: 2_000 })
    const long = shared.request('config/read', { cwd: '/work' }, { timeoutMs: 10_000 })
    const shortFailed = expect(short).rejects.toThrow(/timed out after 2000ms/)
    await vi.advanceTimersByTimeAsync(2_001)
    await shortFailed
    answer({ config: {} })
    expect(await long).toEqual({ config: {} })
  })

  it('reads again for another folder, and passes other requests through', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => ({
      method,
      params
    }))
    const shared = sharingCodexConfigReads({ request })
    await shared.request('config/read', { cwd: '/a' })
    await shared.request('config/read', { cwd: '/b' })
    await shared.request('thread/start', { cwd: '/a' })
    await shared.request('thread/start', { cwd: '/a' })
    expect(request).toHaveBeenCalledTimes(4)
  })
})
