import type * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveAppImageRelaunchPath,
  resolveAppImageRuntimeIdentity
} from './appimage-runtime-identity'

const realFs = vi.hoisted((): { closeSync: typeof fs.closeSync } => ({
  closeSync: () => {
    throw new Error('real closeSync was not captured by the node:fs mock')
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  realFs.closeSync = actual.closeSync
  return { ...actual, closeSync: vi.fn(actual.closeSync), openSync: vi.fn(actual.openSync) }
})

const fixtureRoots: string[] = []

function appImageHeader(machine: number): Buffer {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01])
  header.set([0x41, 0x49, 0x02], 8)
  header.writeUInt16LE(machine, 18)
  return header
}

function createFixture(appDirName = '.mount_Orca123', machine = 0x3e) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'orca-appimage-identity-'))
  const appImagePath = join(root, 'Applications', 'Orca.AppImage')
  const appDirPath = join(root, appDirName)
  const execPath = join(appDirPath, 'orca-ide')
  const resourcesPath = join(appDirPath, 'resources')
  const packageTypePath = join(resourcesPath, 'package-type')
  const packageMarkerPath = join(resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
  fixtureRoots.push(root)
  mkdirSync(dirname(appImagePath), { recursive: true })
  mkdirSync(dirname(packageMarkerPath), { recursive: true })
  writeFileSync(appImagePath, appImageHeader(machine), { mode: 0o755 })
  writeFileSync(join(appDirPath, 'AppRun'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(execPath, appImageHeader(machine), { mode: 0o755 })
  writeFileSync(
    packageMarkerPath,
    JSON.stringify({ name: 'orca-compiled-output', type: 'commonjs', private: true })
  )
  return {
    root,
    appImagePath,
    appDirPath,
    execPath,
    resourcesPath,
    packageTypePath,
    packageMarkerPath,
    identity: {
      platform: 'linux' as const,
      environment: { APPIMAGE: appImagePath, APPDIR: appDirPath },
      execPath,
      resourcesPath
    }
  }
}

afterEach(() => {
  vi.resetAllMocks()
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('resolveAppImageRuntimeIdentity', () => {
  it('uses the outer artifact through a symlink and declines it once the target disappears', async () => {
    const fixture = createFixture()
    const link = join(fixture.root, 'Orca Nightly.AppImage')
    symlinkSync(fixture.appImagePath, link)
    const identity = {
      ...fixture.identity,
      environment: { ...fixture.identity.environment, APPIMAGE: link }
    }

    expect(await resolveAppImageRelaunchPath(identity)).toBe(fixture.appImagePath)
    rmSync(fixture.appImagePath)
    expect(await resolveAppImageRelaunchPath(identity)).toBeNull()
  })

  it.each([
    ['x64', 0x3e, '.mount_Orca123'],
    ['ARM64 extract-and-run', 0xb7, 'appimage_extracted_123']
  ])('accepts a complete %s AppImage runtime', (_architecture, machine, appDirName) => {
    const fixture = createFixture(appDirName, machine)
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toEqual({
      appImagePath: fixture.appImagePath
    })
  })

  it('rejects payload evidence that resolves outside APPDIR', () => {
    const fixture = createFixture()
    const externalAppRun = join(fixture.root, 'foreign-AppRun')
    writeFileSync(externalAppRun, '#!/bin/sh\n', { mode: 0o755 })
    rmSync(join(fixture.appDirPath, 'AppRun'))
    symlinkSync(externalAppRun, join(fixture.appDirPath, 'AppRun'))
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
  })

  it('rejects a package marker that resolves outside APPDIR', () => {
    const fixture = createFixture()
    const externalMarker = join(fixture.root, 'foreign-package.json')
    writeFileSync(
      externalMarker,
      JSON.stringify({ name: 'orca-compiled-output', type: 'commonjs' })
    )
    rmSync(fixture.packageMarkerPath)
    symlinkSync(externalMarker, fixture.packageMarkerPath)
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
  })
})
