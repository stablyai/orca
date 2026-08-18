import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock } = vi.hoisted(() => ({ appMock: { isPackaged: true } }))

vi.mock('electron', () => ({ app: appMock }))

const originalPlatform = process.platform
const originalResourcesPath = process.resourcesPath as string | undefined

let resourcesDir: string

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function setResourcesPath(value: unknown): void {
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value })
}

async function writeMarker(contents: string): Promise<void> {
  await fsp.writeFile(path.join(resourcesDir, 'package-type'), contents, 'utf8')
}

async function loadPackageType(): Promise<() => 'deb' | 'rpm' | null> {
  const module = await import('./linux-update-package-type')
  return module.getLinuxRootPackageType
}

beforeEach(async () => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  appMock.isPackaged = true
  setPlatform('linux')
  resourcesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-package-type-'))
  setResourcesPath(resourcesDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  setPlatform(originalPlatform)
  setResourcesPath(originalResourcesPath)
  await fsp.rm(resourcesDir, { recursive: true, force: true })
})

describe('getLinuxRootPackageType', () => {
  it('reads a deb marker', async () => {
    await writeMarker('deb')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBe('deb')
  })

  it('reads an rpm marker', async () => {
    await writeMarker('rpm')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBe('rpm')
  })

  it('trims surrounding whitespace', async () => {
    await writeMarker('\n  rpm \t\n')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBe('rpm')
  })

  it('treats the AppImage marker as not a root package', async () => {
    await writeMarker('AppImage')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('treats an unknown marker value as not a root package', async () => {
    await writeMarker('snap')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('treats a pacman marker as a recognized but unsupported target', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeMarker('pacman')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('rejects a marker that only differs by case', async () => {
    await writeMarker('DEB')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('returns null when the marker is missing', async () => {
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('returns null when the marker is unreadable', async () => {
    // A directory in the marker's place makes readFileSync fail with EISDIR.
    await fsp.mkdir(path.join(resourcesDir, 'package-type'))
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('returns null when resourcesPath is unavailable', async () => {
    setResourcesPath(undefined)
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('returns null when resourcesPath is empty', async () => {
    setResourcesPath('')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('ignores a readable marker in an unpackaged dev run', async () => {
    await writeMarker('deb')
    appMock.isPackaged = false
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('ignores a readable marker off Linux', async () => {
    await writeMarker('deb')
    setPlatform('darwin')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('caches the resolved type for the process lifetime', async () => {
    await writeMarker('deb')
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBe('deb')
    await writeMarker('rpm')
    expect(getLinuxRootPackageType()).toBe('deb')
  })

  it('caches a resolved null so a later marker is not picked up', async () => {
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
    await writeMarker('deb')
    expect(getLinuxRootPackageType()).toBeNull()
  })

  it('warns about an unknown marker value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeMarker('snap')
    const getLinuxRootPackageType = await loadPackageType()
    getLinuxRootPackageType()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('marker is not deb or rpm')
  })

  it('reads the marker once and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A directory in place of the marker is readable-but-unusable, which is the case worth reporting.
    await fsp.mkdir(path.join(resourcesDir, 'package-type'))
    const getLinuxRootPackageType = await loadPackageType()
    getLinuxRootPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('marker unreadable')
  })

  // Why: AppImage ships no marker at all, so the normal case must stay silent.
  it('stays silent when no marker is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getLinuxRootPackageType = await loadPackageType()
    expect(getLinuxRootPackageType()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn in a dev run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    appMock.isPackaged = false
    const getLinuxRootPackageType = await loadPackageType()
    getLinuxRootPackageType()
    expect(warn).not.toHaveBeenCalled()
  })
})
