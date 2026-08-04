import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'

const wslState = vi.hoisted<{ home: string | null; defaultDistro: string | null }>(() => ({
  home: null,
  defaultDistro: null
}))

vi.mock('../wsl', () => ({
  getWslHome: vi.fn(() => wslState.home),
  getDefaultWslDistro: vi.fn(() => wslState.defaultDistro)
}))

import { resolveKimiHomePath } from './kimi-home-path'

const WSL_HOME_UNC = '\\\\wsl.localhost\\Ubuntu\\home\\cengiz'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...overrides }
}

describe('resolveKimiHomePath', () => {
  beforeEach(() => {
    wslState.home = WSL_HOME_UNC
    wslState.defaultDistro = 'Ubuntu'
  })

  it('resolves to the host default for a host runtime policy', () => {
    const result = resolveKimiHomePath(settings({ localAccountRuntime: 'host' }), 'win32')

    expect(result).toEqual({ runtime: 'host', wslDistro: null, homePath: null })
  })

  it('resolves the configured distro home over its UNC path for a WSL policy', () => {
    const result = resolveKimiHomePath(
      settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
      'win32'
    )

    expect(result).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      homePath: `${WSL_HOME_UNC}\\.kimi-code`
    })
  })

  it('falls back to the default distro when the WSL policy pins none', () => {
    const result = resolveKimiHomePath(
      settings({ localAccountRuntime: 'wsl', localAccountWslDistro: null }),
      'win32'
    )

    expect(result).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      homePath: `${WSL_HOME_UNC}\\.kimi-code`
    })
  })

  it('follows the global Windows runtime default for the auto policy', () => {
    const result = resolveKimiHomePath(
      settings({
        localAccountRuntime: 'auto',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }),
      'win32'
    )

    expect(result.runtime).toBe('wsl')
    expect(result.homePath).toBe(`${WSL_HOME_UNC}\\.kimi-code`)
  })

  it('resolves to the host default for the auto policy off Windows', () => {
    const result = resolveKimiHomePath(
      settings({
        localAccountRuntime: 'auto',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }),
      'darwin'
    )

    expect(result).toEqual({ runtime: 'host', wslDistro: null, homePath: null })
  })

  it('resolves to the host default for a WSL policy off Windows', () => {
    const result = resolveKimiHomePath(
      settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
      'darwin'
    )

    expect(result).toEqual({ runtime: 'host', wslDistro: null, homePath: null })
  })

  it('reports an unresolvable WSL home as a null home path', () => {
    wslState.home = null

    const result = resolveKimiHomePath(
      settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
      'win32'
    )

    expect(result).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu', homePath: null })
  })
})
