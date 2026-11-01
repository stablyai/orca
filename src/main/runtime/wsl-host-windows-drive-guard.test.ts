import { describe, expect, it } from 'vitest'
import { WslHostWindowsDriveRefusalError } from '../../shared/wsl-host-windows-drive-refusal'
import {
  refuseWslHostWindowsDrivePath,
  type WslHostWindowsDriveGuardDeps
} from './wsl-host-windows-drive-guard'

function deps(overrides: Partial<WslHostWindowsDriveGuardDeps> = {}): WslHostWindowsDriveGuardDeps {
  return {
    isWslHost: () => true,
    readMounts: async () => [
      { mountPoint: '/mnt/c', windowsRoot: 'C:\\' },
      { mountPoint: '/win/d drive', windowsRoot: 'D:\\' },
      { mountPoint: '/usr/lib/wsl/drivers', windowsRoot: null }
    ],
    realpath: async (path) => path,
    ...overrides
  }
}

async function refusal(path: string, guardDeps = deps()): Promise<unknown> {
  return refuseWslHostWindowsDrivePath(path, guardDeps).then(
    () => null,
    (error: unknown) => error
  )
}

describe('refuseWslHostWindowsDrivePath', () => {
  it('refuses a drive mount with the path this computer uses for it', async () => {
    const error = await refusal('/mnt/c/Users/me/src/')
    expect(error).toBeInstanceOf(WslHostWindowsDriveRefusalError)
    expect(error).toMatchObject({ data: { windowsPath: 'C:\\Users\\me\\src' } })
    await expect(refusal('/win/d drive')).resolves.toMatchObject({
      data: { windowsPath: 'D:\\' }
    })
  })

  it('refuses a Linux path that resolves onto a drive', async () => {
    const error = await refusal('/home/me/src', deps({ realpath: async () => '/mnt/c/work/src' }))
    expect(error).toMatchObject({ data: { windowsPath: 'C:\\work\\src' } })
  })

  it('still refuses a missing folder by its spelling', async () => {
    const error = await refusal(
      '/mnt/c/new',
      deps({ realpath: () => Promise.reject(new Error('ENOENT')) })
    )
    expect(error).toMatchObject({ data: { windowsPath: 'C:\\new' } })
  })

  it('refuses without an alternative when the mount does not name its drive', async () => {
    await expect(refusal('/usr/lib/wsl/drivers/x')).resolves.toMatchObject({
      data: { windowsPath: null }
    })
  })

  it('rereads mounts per check, so a drive mounted after orcad started is caught', async () => {
    let mounted = false
    const guardDeps = deps({
      readMounts: async () => (mounted ? [{ mountPoint: '/mnt/q', windowsRoot: 'Q:\\' }] : [])
    })
    await expect(refusal('/mnt/q/src', guardDeps)).resolves.toBeNull()
    mounted = true
    await expect(refusal('/mnt/q/src', guardDeps)).resolves.toMatchObject({
      data: { windowsPath: 'Q:\\src' }
    })
  })

  it('allows Linux folders, look-alike prefixes, and every non-WSL host', async () => {
    await expect(refusal('/home/me/src')).resolves.toBeNull()
    await expect(refusal('/mnt/cache/src')).resolves.toBeNull()
    // SSH hosts and the desktop never carry the WSL-host marker.
    await expect(refusal('/mnt/c/src', deps({ isWslHost: () => false }))).resolves.toBeNull()
    await expect(refusal('/mnt/c/src', deps({ readMounts: async () => [] }))).resolves.toBeNull()
  })
})
