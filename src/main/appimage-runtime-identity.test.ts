import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasAppImagePathEnvironment,
  resolveAppImageRuntimeIdentity
} from './appimage-runtime-identity'

const fixtureRoots: string[] = []

function appImageHeader(machine: number): Buffer {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01])
  header.set([0x41, 0x49, 0x02], 8)
  header.writeUInt16LE(machine, 18)
  return header
}

function createFixture(appDirName = '.mount_Orca123', machine = 0x3e) {
  const root = mkdtempSync(join(tmpdir(), 'orca-appimage-identity-'))
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
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('resolveAppImageRuntimeIdentity', () => {
  it.each([
    ['x64', 0x3e, '.mount_Orca123'],
    ['ARM64 extract-and-run', 0xb7, 'appimage_extracted_123']
  ])('accepts a complete %s AppImage runtime', (_architecture, machine, appDirName) => {
    const fixture = createFixture(appDirName, machine)
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toEqual({
      appImagePath: fixture.appImagePath
    })
  })

  it('accepts an AppImage moved independently of its runtime directory', () => {
    const fixture = createFixture()
    const movedPath = join(fixture.root, 'Moved Apps', 'Orca current.AppImage')
    mkdirSync(dirname(movedPath), { recursive: true })
    renameSync(fixture.appImagePath, movedPath)
    fixture.identity.environment.APPIMAGE = movedPath
    expect(resolveAppImageRuntimeIdentity(fixture.identity)?.appImagePath).toBe(movedPath)
  })

  it('accepts the exact AppImage package-type marker', () => {
    const fixture = createFixture()
    rmSync(fixture.packageMarkerPath)
    writeFileSync(fixture.packageTypePath, 'AppImage')
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).not.toBeNull()
  })

  it.each([
    ['APPIMAGE', undefined],
    ['APPIMAGE', 'relative/Orca.AppImage'],
    ['APPDIR', undefined],
    ['APPDIR', 'relative/mount'],
    ['APPIMAGE', '/tmp/Orca\0.AppImage']
  ] as const)('rejects an unusable %s value', (key, value) => {
    const fixture = createFixture()
    expect(
      resolveAppImageRuntimeIdentity({
        ...fixture.identity,
        environment: { ...fixture.identity.environment, [key]: value }
      })
    ).toBeNull()
  })

  it.each([
    ['an ordinary executable', (path: string) => writeFileSync(path, '#!/bin/sh\n')],
    [
      'bad ELF magic',
      (path: string) => {
        const header = appImageHeader(0x3e)
        header[0] = 0
        writeFileSync(path, header)
      }
    ],
    [
      'bad AppImage type magic',
      (path: string) => {
        const header = appImageHeader(0x3e)
        header[10] = 1
        writeFileSync(path, header)
      }
    ],
    ['a non-executable file', (path: string) => chmodSync(path, 0o644)],
    [
      'a directory',
      (path: string) => {
        rmSync(path)
        mkdirSync(path)
      }
    ]
  ])('rejects APPIMAGE pointing to %s', (_case, mutate) => {
    const fixture = createFixture()
    mutate(fixture.appImagePath)
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
  })

  it.each([
    [
      'AppRun',
      (fixture: ReturnType<typeof createFixture>) => rmSync(join(fixture.appDirPath, 'AppRun'))
    ],
    [
      'an executable AppRun',
      (fixture: ReturnType<typeof createFixture>) =>
        chmodSync(join(fixture.appDirPath, 'AppRun'), 0o644)
    ],
    [
      'the Orca package marker',
      (fixture: ReturnType<typeof createFixture>) => rmSync(fixture.packageMarkerPath)
    ]
  ])('rejects a runtime missing %s', (_case, mutate) => {
    const fixture = createFixture()
    mutate(fixture)
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
  })

  it('rejects forged AppImage variables around an ordinary packaged layout', () => {
    const fixture = createFixture()
    rmSync(join(fixture.appDirPath, 'AppRun'))
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
  })

  it('rejects a package marker for a different application', () => {
    const fixture = createFixture()
    writeFileSync(
      fixture.packageMarkerPath,
      JSON.stringify({ name: 'foreign-compiled-output', type: 'commonjs' })
    )
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
  })

  it('rejects an inexact package-type marker without the Orca fallback', () => {
    const fixture = createFixture()
    rmSync(fixture.packageMarkerPath)
    writeFileSync(fixture.packageTypePath, 'appimage')
    expect(resolveAppImageRuntimeIdentity(fixture.identity)).toBeNull()
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

  it('rejects inherited AppImage variables around a non-AppImage executable', () => {
    const fixture = createFixture()
    expect(
      resolveAppImageRuntimeIdentity({
        ...fixture.identity,
        execPath: join(fixture.root, 'opt', 'Orca', 'orca-ide'),
        resourcesPath: join(fixture.root, 'opt', 'Orca', 'resources')
      })
    ).toBeNull()
  })

  it('rejects a resources path outside the runtime root', () => {
    const fixture = createFixture()
    expect(
      resolveAppImageRuntimeIdentity({
        ...fixture.identity,
        resourcesPath: `${fixture.appDirPath}-other/resources`
      })
    ).toBeNull()
  })

  it('rejects the identity off Linux', () => {
    const fixture = createFixture()
    expect(resolveAppImageRuntimeIdentity({ ...fixture.identity, platform: 'darwin' })).toBeNull()
  })
})

describe('hasAppImagePathEnvironment', () => {
  it('requires the AppImage file path before treating the runtime as verifiable', () => {
    expect(hasAppImagePathEnvironment({ APPIMAGE: '/tmp/Orca.AppImage' })).toBe(true)
    expect(hasAppImagePathEnvironment({ APPDIR: '/tmp/.mount_Orca123' })).toBe(false)
    expect(hasAppImagePathEnvironment({ APPIMAGE: '', APPDIR: '/tmp/.mount_Orca123' })).toBe(false)
  })
})
