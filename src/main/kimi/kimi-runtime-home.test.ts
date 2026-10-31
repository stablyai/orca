import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>(),
  listRunningWslDistrosAsync: vi.fn<() => Promise<string[]>>(),
  getWslHomeAsync: vi.fn<(distro: string) => Promise<string | null>>()
}))

vi.mock('../wsl', () => wslMocks)
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\neil' }))

import { getHostKimiHome, resolveKimiHome } from './kimi-runtime-home'

describe('resolveKimiHome', () => {
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME

  beforeEach(() => {
    delete process.env.KIMI_CODE_HOME
    wslMocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    wslMocks.listRunningWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    wslMocks.getWslHomeAsync.mockReset().mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\neil')
  })

  afterEach(() => {
    if (originalKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = originalKimiCodeHome
    }
  })

  it('ignores the host KIMI_CODE_HOME when reading a WSL home', async () => {
    process.env.KIMI_CODE_HOME = 'D:\\kimi-home'
    expect((await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).path).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    )
  })

  it('reports no path without probing the home while the distro is stopped', async () => {
    wslMocks.listRunningWslDistrosAsync.mockResolvedValue([])
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: null
    })
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('never probes WSL off Windows', async () => {
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'darwin')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
    expect(wslMocks.listWslDistrosAsync).not.toHaveBeenCalled()
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })
})
