import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>(),
  getWslHomeAsync: vi.fn<(distro: string) => Promise<string | null>>()
}))

vi.mock('../wsl', () => wslMocks)
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\neil' }))

import { getGrokRuntimeTarget, getHostGrokHome, resolveGrokHome } from './grok-runtime-home'
import type { GlobalSettings } from '../../shared/global-settings-types'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return overrides as GlobalSettings
}

describe('getGrokRuntimeTarget', () => {
  it('follows the configured WSL runtime on Windows', () => {
    expect(
      getGrokRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: ' Ubuntu ' }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('pins to host off Windows even when the setting says wsl', () => {
    expect(
      getGrokRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
        'darwin'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('follows the Windows runtime default when the policy is auto', () => {
    expect(
      getGrokRuntimeTarget(
        settings({
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
        }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Debian' })
  })
})

describe('resolveGrokHome', () => {
  const originalGrokHome = process.env.GROK_HOME

  beforeEach(() => {
    delete process.env.GROK_HOME
    wslMocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    wslMocks.getWslHomeAsync.mockReset().mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\neil')
  })

  afterEach(() => {
    if (originalGrokHome === undefined) {
      delete process.env.GROK_HOME
    } else {
      process.env.GROK_HOME = originalGrokHome
    }
  })

  it('resolves the host Grok home for a host target', async () => {
    expect(await resolveGrokHome({ runtime: 'host', wslDistro: null }, 'win32')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostGrokHome()
    })
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('honors host GROK_HOME for a host target', async () => {
    process.env.GROK_HOME = 'D:\\grok-home'

    expect((await resolveGrokHome({ runtime: 'host', wslDistro: null }, 'win32')).path).toBe(
      'D:\\grok-home'
    )
  })

  it('resolves the selected WSL distro home', async () => {
    expect(await resolveGrokHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.grok'
    })
  })

  it('ignores the host GROK_HOME when reading a WSL home', async () => {
    process.env.GROK_HOME = 'D:\\grok-home'

    expect((await resolveGrokHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).path).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.grok'
    )
  })

  it('falls back to the default distro when none is configured', async () => {
    expect(await resolveGrokHome({ runtime: 'wsl', wslDistro: null }, 'win32')).toMatchObject({
      wslDistro: 'Ubuntu'
    })
    expect(wslMocks.getWslHomeAsync).toHaveBeenCalledWith('Ubuntu')
  })

  it('reports no path when the distro home cannot be probed', async () => {
    wslMocks.getWslHomeAsync.mockResolvedValue(null)

    expect(await resolveGrokHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: null
    })
  })

  it('reports no path when no WSL distro exists', async () => {
    wslMocks.listWslDistrosAsync.mockResolvedValue([])

    expect(await resolveGrokHome({ runtime: 'wsl', wslDistro: null }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: null,
      path: null
    })
  })

  it('never probes WSL off Windows', async () => {
    expect(await resolveGrokHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'linux')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostGrokHome()
    })
    expect(wslMocks.listWslDistrosAsync).not.toHaveBeenCalled()
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })
})
