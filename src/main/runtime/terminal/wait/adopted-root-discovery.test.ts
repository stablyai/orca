import { describe, expect, it, vi } from 'vitest'
import { AdoptedRootDiscovery } from './adopted-root-discovery'

describe('root lookups for old local owners', () => {
  it('answers a sweep of panes with one inventory request', async () => {
    const list = vi.fn(async (ids: readonly string[]) =>
      ids
        .filter((id) => id !== 'pty-gone')
        .map((id, index) => ({
          id,
          incarnationId: `inc-${id}`,
          rootProcessId: 500 + index
        }))
    )
    const discovery = new AdoptedRootDiscovery(list)
    const found = await Promise.all(['pty-1', 'pty-2', 'pty-gone'].map((id) => discovery.find(id)))
    expect(list).toHaveBeenCalledTimes(1)
    expect(found).toEqual([
      { incarnationId: 'inc-pty-1', pid: 500 },
      { incarnationId: 'inc-pty-2', pid: 501 },
      null
    ])
  })

  it('reads a failed listing as unknown and lists again for the next sweep', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('owner_unavailable'))
      .mockResolvedValueOnce([{ id: 'pty-1', incarnationId: 'inc', rootProcessId: 42 }])
    const discovery = new AdoptedRootDiscovery(list)
    await expect(discovery.find('pty-1')).resolves.toBeNull()
    await expect(discovery.find('pty-1')).resolves.toEqual({ incarnationId: 'inc', pid: 42 })
    expect(list).toHaveBeenCalledTimes(2)
  })
})
