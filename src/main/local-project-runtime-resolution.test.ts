import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalWindowsRuntimeDefault } from '../shared/project-execution-runtime'
import { resolveLocalGlobalRuntime } from './local-project-runtime-resolution'

const wslCache = vi.hoisted((): { availability: boolean | null; distros: string[] | null } => ({
  availability: null,
  distros: null
}))

vi.mock('./wsl', () => ({
  hasCachedWslAvailability: () => wslCache.availability !== null,
  getCachedWslAvailability: () => wslCache.availability,
  hasCachedWslDistros: () => wslCache.distros !== null,
  getCachedWslDistros: () => wslCache.distros
}))

function storeWith(localWindowsRuntimeDefault?: GlobalWindowsRuntimeDefault) {
  return { getSettings: () => ({ localWindowsRuntimeDefault }) }
}

describe('resolveLocalGlobalRuntime', () => {
  beforeEach(() => {
    wslCache.availability = null
    wslCache.distros = null
  })

  it('resolves a named WSL default when the cache is cold', () => {
    expect(
      resolveLocalGlobalRuntime(storeWith({ kind: 'wsl', distro: 'Ubuntu' }), 'win32')
    ).toMatchObject({ status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } })
  })

  it('requires repair for a WSL default without a distro', () => {
    expect(
      resolveLocalGlobalRuntime(storeWith({ kind: 'wsl', distro: null }), 'win32')
    ).toMatchObject({ status: 'repair-required', repair: { reason: 'wsl-distro-required' } })
  })

  it('requires repair when the cache knows the distro is missing or WSL is off', () => {
    const store = storeWith({ kind: 'wsl', distro: 'Ubuntu' })
    wslCache.availability = true
    wslCache.distros = ['Debian']
    expect(resolveLocalGlobalRuntime(store, 'win32')).toMatchObject({
      repair: { reason: 'wsl-distro-missing' }
    })
    wslCache.availability = false
    expect(resolveLocalGlobalRuntime(store, 'win32')).toMatchObject({
      repair: { reason: 'wsl-unavailable' }
    })
  })

  it('stays on the host for a Windows-host default, non-Windows hosts, or no settings', () => {
    expect(resolveLocalGlobalRuntime(storeWith({ kind: 'windows-host' }), 'win32')).toMatchObject({
      status: 'resolved',
      runtime: { kind: 'windows-host' }
    })
    expect(
      resolveLocalGlobalRuntime(storeWith({ kind: 'wsl', distro: 'Ubuntu' }), 'linux')
    ).toMatchObject({ status: 'resolved', runtime: { kind: 'local-host' } })
    expect(resolveLocalGlobalRuntime({}, 'win32')).toBeUndefined()
  })
})
