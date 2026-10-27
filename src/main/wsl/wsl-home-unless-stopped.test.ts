import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWslHomeAsync: vi.fn(async () => '\\\\wsl.localhost\\Ubuntu\\home\\jin'),
  getCachedWslHome: vi.fn((): string | null | undefined => undefined),
  blocked: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null)
}))
vi.mock('../wsl', () => ({ getWslHomeAsync: mocks.getWslHomeAsync }))
vi.mock('../wsl-home-cache', () => ({ getCachedWslHome: mocks.getCachedWslHome }))
vi.mock('./wsl-unc-access-gate', () => ({ blockedWslDistroForPath: mocks.blocked }))

import { wslHomeUnlessStopped } from './wsl-home-unless-stopped'

beforeEach(() => {
  vi.clearAllMocks()
})

// getAllowedRoots runs on every file authorization; an uncached home probe would boot the distro (E9).
describe('wslHomeUnlessStopped', () => {
  it('does not probe the home of a stopped distro', async () => {
    mocks.blocked.mockResolvedValueOnce({ distro: 'Ubuntu', state: 'stopped' })
    await expect(wslHomeUnlessStopped('Ubuntu')).resolves.toBeNull()
    expect(mocks.blocked).toHaveBeenCalledWith('', 'Ubuntu')
    expect(mocks.getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('probes a running distro, and a cached home without asking', async () => {
    await expect(wslHomeUnlessStopped('Ubuntu')).resolves.toContain('jin')
    mocks.getCachedWslHome.mockReturnValueOnce('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    await wslHomeUnlessStopped('Ubuntu')
    expect(mocks.blocked).toHaveBeenCalledOnce()
  })
})
