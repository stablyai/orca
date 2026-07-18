import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWslStatusEnvironmentProbeCommand,
  clearWslStatusEnvironmentCacheForTests,
  invalidateWslStatusEnvironment,
  parseWslStatusEnvironmentProbe,
  resolveWslStatusEnvironment,
  type WslStatusEnvironment
} from './wsl-status-environment'

const ubuntuEnvironment = { gitPath: '/usr/bin/git', path: '/usr/local/bin:/usr/bin' }

afterEach(() => {
  clearWslStatusEnvironmentCacheForTests()
  vi.useRealTimers()
})

describe('WSL status environment probe', () => {
  it('prints and parses a login-shell-resolved absolute git and PATH', () => {
    expect(buildWslStatusEnvironmentProbeCommand()).toContain('command -v git')
    expect(
      parseWslStatusEnvironmentProbe(
        `rc noise\n\0orca-wsl-status-environment-v1\0/usr/bin/git\0/usr/local/bin:/usr/bin\0`
      )
    ).toEqual(ubuntuEnvironment)
    expect(parseWslStatusEnvironmentProbe('missing marker')).toBeNull()
    expect(
      parseWslStatusEnvironmentProbe(`\0orca-wsl-status-environment-v1\0relative/git\0/usr/bin\0`)
    ).toBeNull()
  })
})

describe('resolveWslStatusEnvironment', () => {
  it('reuses the first result per distro and isolates different distros', async () => {
    const probe = vi.fn(async (distro: string) =>
      distro === 'Ubuntu'
        ? ubuntuEnvironment
        : { gitPath: '/opt/git/bin/git', path: '/opt/git/bin:/usr/bin' }
    )

    await expect(resolveWslStatusEnvironment('Ubuntu', probe)).resolves.toBe(ubuntuEnvironment)
    await expect(resolveWslStatusEnvironment('Ubuntu', probe)).resolves.toBe(ubuntuEnvironment)
    await expect(resolveWslStatusEnvironment('Debian', probe)).resolves.toEqual({
      gitPath: '/opt/git/bin/git',
      path: '/opt/git/bin:/usr/bin'
    })

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent probes for the same distro', async () => {
    let finishProbe!: (environment: WslStatusEnvironment) => void
    const pending = new Promise<WslStatusEnvironment>((resolve) => {
      finishProbe = resolve
    })
    const probe = vi.fn(() => pending)

    const first = resolveWslStatusEnvironment('Ubuntu', probe)
    const second = resolveWslStatusEnvironment('Ubuntu', probe)
    finishProbe(ubuntuEnvironment)

    await expect(Promise.all([first, second])).resolves.toEqual([
      ubuntuEnvironment,
      ubuntuEnvironment
    ])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('lets one caller abort without cancelling or evicting the shared probe', async () => {
    let finishProbe!: (environment: WslStatusEnvironment) => void
    const pending = new Promise<WslStatusEnvironment>((resolve) => {
      finishProbe = resolve
    })
    const probe = vi.fn(() => pending)
    const controller = new AbortController()

    const owner = resolveWslStatusEnvironment('Ubuntu', probe)
    const waiter = resolveWslStatusEnvironment('Ubuntu', probe, controller.signal)
    controller.abort()

    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' })
    finishProbe(ubuntuEnvironment)
    await expect(owner).resolves.toBe(ubuntuEnvironment)
    await expect(resolveWslStatusEnvironment('Ubuntu', probe)).resolves.toBe(ubuntuEnvironment)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('negative-caches a rejected probe instead of doubling every fallback', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('broken login rc'))

    await expect(resolveWslStatusEnvironment('Ubuntu', probe)).resolves.toBeNull()
    await expect(resolveWslStatusEnvironment('Ubuntu', probe)).resolves.toBeNull()

    expect(probe).toHaveBeenCalledOnce()
  })

  it('invalidates only the exact cached environment instance', async () => {
    const probe = vi.fn().mockResolvedValue(ubuntuEnvironment)
    await resolveWslStatusEnvironment('Ubuntu', probe)

    invalidateWslStatusEnvironment('Ubuntu', { ...ubuntuEnvironment })
    await resolveWslStatusEnvironment('Ubuntu', probe)
    expect(probe).toHaveBeenCalledOnce()

    invalidateWslStatusEnvironment('Ubuntu', ubuntuEnvironment)
    await resolveWslStatusEnvironment('Ubuntu', probe)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
