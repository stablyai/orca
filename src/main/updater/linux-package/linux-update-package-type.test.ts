import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const { dpkgListedMock } = vi.hoisted(() => ({ dpkgListedMock: vi.fn(() => true) }))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
// Arch ships dpkg, so the manager is found either way; ownership is what differs.
vi.mock('./linux-package-install-command', () => ({ hasTrustedPackageManagerFor: () => true }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (candidate: NodeFs.PathLike) =>
      candidate === '/var/lib/dpkg/info/orca-ide.list'
        ? dpkgListedMock()
        : actual.existsSync(candidate)
  }
})

describe('isExternallyManagedLinuxInstall', () => {
  const originalPlatform = process.platform
  const originalResourcesPath = process.resourcesPath

  beforeEach(() => {
    vi.resetModules()
    const resourcesPath = mkdtempSync(path.join(os.tmpdir(), 'orca-package-type-'))
    writeFileSync(path.join(resourcesPath, 'package-type'), 'deb\n')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true
    })
  })

  it('leaves a deb that dpkg installed to the in-app updater', async () => {
    dpkgListedMock.mockReturnValue(true)
    const { isExternallyManagedLinuxInstall } = await import('./linux-update-package-type')
    expect(isExternallyManagedLinuxInstall()).toBe(false)
  })

  it('treats a repackaged deb as externally managed when dpkg is present but did not install it', async () => {
    dpkgListedMock.mockReturnValue(false)
    const { isExternallyManagedLinuxInstall } = await import('./linux-update-package-type')
    expect(isExternallyManagedLinuxInstall()).toBe(true)
  })
})
