import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinuxPackageType, LinuxRootPackageType } from './linux-update-package-type'

const { appMock, hasTrustedPackageManagerForMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true },
  hasTrustedPackageManagerForMock: vi.fn(() => true)
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('./linux-package-install-command', () => ({
  hasTrustedPackageManagerFor: hasTrustedPackageManagerForMock
}))

const originalPlatform = process.platform
const originalResourcesPath = process.resourcesPath as string | undefined
const originalExecPath = process.execPath
const originalAppImage = process.env.APPIMAGE
const originalAppDir = process.env.APPDIR

let resourcesDir: string

type PackageTypeModule = {
  getLinuxPackageType: () => LinuxPackageType
  getLinuxRootPackageType: () => LinuxRootPackageType | null
  isExternallyManagedLinuxInstall: () => boolean
  isLegacyAppImageRuntimeIdentity: (identity: {
    appImagePath: unknown
    appDirPath: unknown
    execPath: unknown
    resourcesPath: unknown
  }) => boolean
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function setResourcesPath(value: unknown): void {
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value })
}

function setExecPath(value: string): void {
  Object.defineProperty(process, 'execPath', { configurable: true, value })
}

async function writeMarker(contents: string): Promise<void> {
  await fsp.writeFile(path.join(resourcesDir, 'package-type'), contents, 'utf8')
}

async function loadPackageType(): Promise<PackageTypeModule> {
  return import('./linux-update-package-type')
}

beforeEach(async () => {
  vi.resetModules()
  hasTrustedPackageManagerForMock.mockReset().mockReturnValue(true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  appMock.isPackaged = true
  delete process.env.APPIMAGE
  delete process.env.APPDIR
  setPlatform('linux')
  resourcesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-package-type-'))
  setResourcesPath(resourcesDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  setPlatform(originalPlatform)
  setResourcesPath(originalResourcesPath)
  setExecPath(originalExecPath)
  if (originalAppImage === undefined) {
    delete process.env.APPIMAGE
  } else {
    process.env.APPIMAGE = originalAppImage
  }
  if (originalAppDir === undefined) {
    delete process.env.APPDIR
  } else {
    process.env.APPDIR = originalAppDir
  }
  await fsp.rm(resourcesDir, { recursive: true, force: true })
})

describe('getLinuxRootPackageType', () => {
  it('reads a deb marker', async () => {
    await writeMarker('deb')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('deb')
    expect(module.getLinuxRootPackageType()).toBe('deb')
  })

  it('reads an rpm marker', async () => {
    await writeMarker('rpm')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('rpm')
    expect(module.getLinuxRootPackageType()).toBe('rpm')
  })

  it('trims surrounding whitespace', async () => {
    await writeMarker('\n  rpm \t\n')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('rpm')
    expect(module.getLinuxRootPackageType()).toBe('rpm')
  })

  it('treats the AppImage marker as not a root package', async () => {
    await writeMarker('AppImage')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('non-root')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('treats an unknown marker value as unusable', async () => {
    await writeMarker('snap')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('treats a pacman marker as unusable until recovery supports it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeMarker('pacman')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects a marker that only differs by case', async () => {
    await writeMarker('DEB')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('uses a legacy AppImage identity when its executable and resources are inside APPDIR', async () => {
    process.env.APPIMAGE = '/opt/orca/orca.AppImage'
    process.env.APPDIR = '/tmp/.mount_orca'
    setExecPath('/tmp/.mount_orca/orca')
    setResourcesPath('/tmp/.mount_orca/resources')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('non-root')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it.each([
    ['relative APPIMAGE', 'relative/orca.AppImage', '/tmp/.mount_orca'],
    ['relative APPDIR', '/opt/orca/orca.AppImage', 'relative/.mount_orca']
  ])('rejects a legacy identity with %s', async (_label, appImagePath, appDirPath) => {
    process.env.APPIMAGE = appImagePath
    process.env.APPDIR = appDirPath
    setExecPath('/tmp/.mount_orca/orca')
    setResourcesPath('/tmp/.mount_orca/resources')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it.each([
    ['executable', '/tmp/.mount_orca-shadow/orca', '/tmp/.mount_orca/resources'],
    ['resources', '/tmp/.mount_orca/orca', '/tmp/.mount_orca-shadow/resources']
  ])(
    'rejects a prefix-collision outside APPDIR for %s',
    async (_label, execPath, resourcesPath) => {
      process.env.APPIMAGE = '/opt/orca/orca.AppImage'
      process.env.APPDIR = '/tmp/.mount_orca'
      setExecPath(execPath)
      setResourcesPath(resourcesPath)
      const module = await loadPackageType()
      expect(module.getLinuxPackageType()).toBe('unusable')
      expect(module.getLinuxRootPackageType()).toBeNull()
    }
  )

  it('rejects NULs in every legacy AppImage identity path', async () => {
    const { isLegacyAppImageRuntimeIdentity } = await loadPackageType()
    const identity = {
      appImagePath: '/opt/orca/orca.AppImage',
      appDirPath: '/tmp/.mount_orca',
      execPath: '/tmp/.mount_orca/orca',
      resourcesPath: '/tmp/.mount_orca/resources'
    }

    for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
      expect(
        isLegacyAppImageRuntimeIdentity({ ...identity, [field]: `${identity[field]}\0suffix` })
      ).toBe(false)
    }
  })

  it('requires every legacy AppImage identity path to be absolute', async () => {
    const { isLegacyAppImageRuntimeIdentity } = await loadPackageType()
    const identity = {
      appImagePath: '/opt/orca/orca.AppImage',
      appDirPath: '/tmp/.mount_orca',
      execPath: '/tmp/.mount_orca/orca',
      resourcesPath: '/tmp/.mount_orca/resources'
    }

    for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
      expect(isLegacyAppImageRuntimeIdentity({ ...identity, [field]: 'relative/path' })).toBe(false)
    }
  })

  it('prefers a package marker over an invalid legacy AppImage identity', async () => {
    await writeMarker('deb')
    process.env.APPIMAGE = 'relative/orca.AppImage'
    process.env.APPDIR = 'relative/.mount_orca'
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('deb')
    expect(module.getLinuxRootPackageType()).toBe('deb')
  })

  it('returns unusable when the marker is missing without AppImage identity', async () => {
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('returns unusable when the marker is unreadable', async () => {
    // A directory in the marker's place makes readFileSync fail with EISDIR.
    await fsp.mkdir(path.join(resourcesDir, 'package-type'))
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('returns unusable when resourcesPath is unavailable', async () => {
    setResourcesPath(undefined)
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('returns unusable when resourcesPath is empty', async () => {
    setResourcesPath('')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('ignores a readable marker in an unpackaged dev run', async () => {
    await writeMarker('deb')
    appMock.isPackaged = false
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('non-root')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('ignores a readable marker off Linux', async () => {
    await writeMarker('deb')
    setPlatform('darwin')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('non-root')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('caches the resolved type for the process lifetime', async () => {
    await writeMarker('deb')
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('deb')
    expect(module.getLinuxRootPackageType()).toBe('deb')
    await writeMarker('rpm')
    expect(module.getLinuxPackageType()).toBe('deb')
    expect(module.getLinuxRootPackageType()).toBe('deb')
  })

  it('caches an unusable result so a later marker is not picked up', async () => {
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    await writeMarker('deb')
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
  })

  it('warns about an unknown marker value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeMarker('snap')
    const module = await loadPackageType()
    module.getLinuxPackageType()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('marker is not AppImage, deb, or rpm')
  })

  it('reads the marker once and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A directory in place of the marker is readable-but-unusable, which is the case worth reporting.
    await fsp.mkdir(path.join(resourcesDir, 'package-type'))
    const module = await loadPackageType()
    module.getLinuxPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('marker unreadable')
  })

  it('warns when a packaged marker is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const module = await loadPackageType()
    expect(module.getLinuxPackageType()).toBe('unusable')
    expect(module.getLinuxRootPackageType()).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('marker missing'))
  })

  it('does not warn in a dev run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    appMock.isPackaged = false
    const module = await loadPackageType()
    module.getLinuxPackageType()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('isExternallyManagedLinuxInstall', () => {
  // The #17702 case: an AUR/Nix/container rebuild of the .deb inherits `package-type` verbatim.
  it('reports a deb marker with no deb package manager as externally managed', async () => {
    hasTrustedPackageManagerForMock.mockReturnValue(false)
    await writeMarker('deb')
    const module = await loadPackageType()
    expect(module.isExternallyManagedLinuxInstall()).toBe(true)
    expect(hasTrustedPackageManagerForMock).toHaveBeenCalledWith('deb')
  })

  it('reports an rpm marker with no rpm package manager as externally managed', async () => {
    hasTrustedPackageManagerForMock.mockReturnValue(false)
    await writeMarker('rpm')
    const module = await loadPackageType()
    expect(module.isExternallyManagedLinuxInstall()).toBe(true)
    expect(hasTrustedPackageManagerForMock).toHaveBeenCalledWith('rpm')
  })

  it('leaves a real deb host self-updatable', async () => {
    await writeMarker('deb')
    const module = await loadPackageType()
    expect(module.isExternallyManagedLinuxInstall()).toBe(false)
  })

  it('never probes the host for an AppImage install', async () => {
    hasTrustedPackageManagerForMock.mockReturnValue(false)
    await writeMarker('AppImage')
    const module = await loadPackageType()
    expect(module.isExternallyManagedLinuxInstall()).toBe(false)
    expect(hasTrustedPackageManagerForMock).not.toHaveBeenCalled()
  })

  it('never probes the host for an unusable marker', async () => {
    hasTrustedPackageManagerForMock.mockReturnValue(false)
    await writeMarker('snap')
    const module = await loadPackageType()
    expect(module.isExternallyManagedLinuxInstall()).toBe(false)
    expect(hasTrustedPackageManagerForMock).not.toHaveBeenCalled()
  })

  it('probes the host at most once per process', async () => {
    hasTrustedPackageManagerForMock.mockReturnValue(false)
    await writeMarker('deb')
    const module = await loadPackageType()
    module.isExternallyManagedLinuxInstall()
    module.isExternallyManagedLinuxInstall()
    module.isExternallyManagedLinuxInstall()
    expect(hasTrustedPackageManagerForMock).toHaveBeenCalledTimes(1)
  })
})
