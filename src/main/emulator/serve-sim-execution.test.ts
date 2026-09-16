import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  getAppPath: vi.fn(),
  getPath: vi.fn(),
  getVersion: vi.fn()
}))
const materializerMocks = vi.hoisted(() => ({
  materializeServeSimRuntime: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: electronMocks.getAppPath,
    getPath: electronMocks.getPath,
    getVersion: electronMocks.getVersion
  }
}))
vi.mock('./serve-sim-runtime-materializer', () => materializerMocks)

import { resolveServeSimExecutable } from './serve-sim-execution'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const cleanupPaths: string[] = []

function setProcessProperty(name: 'platform' | 'resourcesPath', value: string): void {
  Object.defineProperty(process, name, { configurable: true, value })
}

function restoreProcessProperty(
  name: 'platform' | 'resourcesPath',
  descriptor?: PropertyDescriptor
) {
  if (descriptor) {
    Object.defineProperty(process, name, descriptor)
  } else {
    Reflect.deleteProperty(process, name)
  }
}

async function createServeSimPackage(packageDir: string): Promise<string> {
  const entry = join(packageDir, 'dist', 'serve-sim.js')
  await mkdir(join(packageDir, 'dist'), { recursive: true })
  await writeFile(entry, 'console.log("serve-sim")')
  return entry
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-serve-sim-execution-'))
  cleanupPaths.push(root)
  setProcessProperty('platform', 'linux')
  setProcessProperty('resourcesPath', join(root, 'resources'))
  electronMocks.getAppPath.mockReset().mockReturnValue(join(root, 'app'))
  electronMocks.getPath.mockReset().mockReturnValue(join(root, 'user-data'))
  electronMocks.getVersion.mockReset().mockReturnValue('test-version')
  materializerMocks.materializeServeSimRuntime.mockReset()
})

afterEach(async () => {
  restoreProcessProperty('platform', originalPlatform)
  restoreProcessProperty('resourcesPath', originalResourcesPath)
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('resolveServeSimExecutable', () => {
  it('preserves the legacy Resources/serve-sim path as the first packaged choice', async () => {
    const resourcesPath = process.resourcesPath
    const legacyEntry = await createServeSimPackage(join(resourcesPath, 'serve-sim'))
    await createServeSimPackage(join(resourcesPath, 'node_modules', 'serve-sim'))

    expect(resolveServeSimExecutable()).toEqual({
      command: process.execPath,
      baseArgs: [legacyEntry],
      usesElectronAsNode: true
    })
    expect(electronMocks.getAppPath).not.toHaveBeenCalled()
  })

  it('uses the deduplicated Resources/node_modules/serve-sim package', async () => {
    const packagedEntry = await createServeSimPackage(
      join(process.resourcesPath, 'node_modules', 'serve-sim')
    )

    expect(resolveServeSimExecutable()).toEqual({
      command: process.execPath,
      baseArgs: [packagedEntry],
      usesElectronAsNode: true
    })
    expect(electronMocks.getAppPath).not.toHaveBeenCalled()
  })

  it('materializes either packaged resource location on macOS', async () => {
    setProcessProperty('platform', 'darwin')
    const packagedPackageDir = join(process.resourcesPath, 'node_modules', 'serve-sim')
    await createServeSimPackage(packagedPackageDir)
    const materializedPackageDir = join(process.resourcesPath, 'materialized-serve-sim')
    materializerMocks.materializeServeSimRuntime.mockReturnValue(materializedPackageDir)

    expect(resolveServeSimExecutable()).toEqual({
      command: process.execPath,
      baseArgs: [join(materializedPackageDir, 'dist', 'serve-sim.js')],
      usesElectronAsNode: true
    })
    expect(materializerMocks.materializeServeSimRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ bundledPackageDir: packagedPackageDir })
    )
  })

  it('preserves the app node_modules development fallback', async () => {
    const appPackageDir = join(electronMocks.getAppPath(), 'node_modules', 'serve-sim')
    const appEntry = await createServeSimPackage(appPackageDir)

    expect(resolveServeSimExecutable()).toEqual({
      command: process.execPath,
      baseArgs: [appEntry],
      usesElectronAsNode: true
    })
  })
})
