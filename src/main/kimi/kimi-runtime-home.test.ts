import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>(),
  getWslHomeAsync: vi.fn<(distro: string) => Promise<string | null>>()
}))

vi.mock('../wsl', () => wslMocks)
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\neil' }))

import { getHostKimiHome, getKimiRuntimeTarget, resolveKimiHome } from './kimi-runtime-home'
import type { GlobalSettings } from '../../shared/global-settings-types'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return overrides as GlobalSettings
}

describe('getKimiRuntimeTarget', () => {
  it('follows the configured WSL runtime on Windows', () => {
    expect(
      getKimiRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: ' Ubuntu ' }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('pins to host off Windows even when the setting says wsl', () => {
    expect(
      getKimiRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
        'darwin'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('follows the Windows runtime default when the policy is auto', () => {
    expect(
      getKimiRuntimeTarget(
        settings({
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
        }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Debian' })
  })
})

describe('resolveKimiHome', () => {
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME

  beforeEach(() => {
    delete process.env.KIMI_CODE_HOME
    wslMocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    wslMocks.getWslHomeAsync.mockReset().mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\neil')
  })

  afterEach(() => {
    if (originalKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = originalKimiCodeHome
    }
  })

  it('resolves the host home for a host target', async () => {
    expect(await resolveKimiHome({ runtime: 'host', wslDistro: null }, 'win32')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('resolves the WSL distro home for a WSL target', async () => {
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    })
  })

  it('ignores the host KIMI_CODE_HOME when reading a WSL home', async () => {
    process.env.KIMI_CODE_HOME = 'D:\\kimi-home'
    expect((await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).path).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    )
  })

  it('falls back to the default distro when none is configured', async () => {
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: null }, 'win32')).toMatchObject({
      wslDistro: 'Ubuntu'
    })
    expect(wslMocks.getWslHomeAsync).toHaveBeenCalledWith('Ubuntu')
  })

  it('reports no path when the distro home cannot be probed', async () => {
    wslMocks.getWslHomeAsync.mockResolvedValue(null)
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: null
    })
  })

  it('reports no path when no distro exists at all', async () => {
    wslMocks.listWslDistrosAsync.mockResolvedValue([])
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: null }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: null,
      path: null
    })
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
