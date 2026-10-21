import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import {
  getDaemonHostRootDir,
  getRelocatedDaemonHost,
  materializeRelocatedDaemonHost
} from './daemon-host-relocation'

const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA
const originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron')
const packageRel = join('resources', 'node_modules', '@orca', 'process-host')
let tempDir: string
let installDir: string
let hostRoot: string

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function materializedRoot(): string {
  const host = materializeRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-process-package-'))
  installDir = join(tempDir, 'app')
  buildInstallFixture(installDir)
  process.env.LOCALAPPDATA = join(tempDir, 'localAppData')
  setAppEnvironment({
    getPath: () => join(tempDir, 'userData'),
    getAppPath: () => join(installDir, 'resources', 'app.asar'),
    getVersion: () => '9.9.9',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  setProcessProp('platform', 'win32')
  setProcessProp('execPath', join(installDir, 'Orca.exe'))
  setProcessProp('resourcesPath', join(installDir, 'resources'))
  hostRoot = join(getDaemonHostRootDir(), '9.9.9')
})

afterEach(() => {
  setProcessProp('platform', originalPlatform)
  setProcessProp('execPath', originalExecPath)
  setProcessProp('resourcesPath', originalResourcesPath)
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData
  }
  if (originalElectronVersion) {
    Object.defineProperty(process.versions, 'electron', originalElectronVersion)
  } else {
    Reflect.deleteProperty(process.versions, 'electron')
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('relocated process-host package', () => {
  it('copies the manifest and complete emitted tree without its source', () => {
    const root = materializedRoot()
    const copiedPackage = join(root, packageRel)
    expect(existsSync(join(copiedPackage, 'package.json'))).toBe(true)
    expect(existsSync(join(copiedPackage, 'dist', 'run-process.js'))).toBe(true)
    expect(existsSync(join(copiedPackage, 'dist', 'spawn-observer.js'))).toBe(true)
    expect(existsSync(join(copiedPackage, 'dist', 'run-process.d.ts'))).toBe(true)
    expect(existsSync(join(copiedPackage, 'src'))).toBe(false)
    const entry = join(root, 'resources', 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
    expect(createRequire(entry).resolve('@orca/process-host')).toBe(
      realpathSync(join(copiedPackage, 'dist', 'run-process.js'))
    )
    expect(createRequire(entry).resolve('@orca/process-host/spawn-observer')).toBe(
      realpathSync(join(copiedPackage, 'dist', 'spawn-observer.js'))
    )
  })

  it.each(['package.json', 'dist/run-process.js', 'dist/spawn-observer.js'])(
    'refuses a source missing %s before copying',
    (relative) => {
      rmSync(join(installDir, packageRel, ...relative.split('/')))
      expect(materializeRelocatedDaemonHost()).toBeNull()
      expect(existsSync(hostRoot)).toBe(false)
    }
  )

  it('rejects a mirror missing a private emitted module', () => {
    writeFileSync(
      join(installDir, packageRel, 'dist', 'private-internal.js'),
      'module.exports = {}'
    )
    const root = materializedRoot()
    rmSync(join(root, packageRel, 'dist', 'private-internal.js'))
    expect(getRelocatedDaemonHost()).toBeNull()
    expect(existsSync(join(materializedRoot(), packageRel, 'dist', 'private-internal.js'))).toBe(
      true
    )
  })

  it.each(['package.json', 'dist/run-process.js', 'dist/spawn-observer.js'])(
    'rejects a mirror missing %s and preserves it while publishing a repair',
    (relative) => {
      const root = materializedRoot()
      const sentinel = join(root, 'live-host-sentinel')
      writeFileSync(sentinel, 'keep')
      rmSync(join(root, packageRel, ...relative.split('/')))
      expect(getRelocatedDaemonHost()).toBeNull()
      const repaired = materializedRoot()
      expect(repaired).not.toBe(root)
      expect(existsSync(join(repaired, packageRel, ...relative.split('/')))).toBe(true)
      expect(readFileSync(sentinel, 'utf8')).toBe('keep')
    }
  )

  it.each(['bytes', 'file list'])(
    'distinguishes the same app version when package %s change',
    (change) => {
      const previous = materializedRoot()
      const file = join(
        installDir,
        packageRel,
        'dist',
        change === 'bytes' ? 'spawn-observer.js' : 'new-module.js'
      )
      writeFileSync(file, 'module.exports = { changed: true }')
      expect(getRelocatedDaemonHost()).toBeNull()
      const current = materializedRoot()
      expect(current).not.toBe(previous)
      expect(dirname(current)).toBe(hostRoot)
      expect(existsSync(join(previous, 'Orca.exe'))).toBe(true)
      expect(
        readFileSync(
          join(
            current,
            packageRel,
            'dist',
            change === 'bytes' ? 'spawn-observer.js' : 'new-module.js'
          ),
          'utf8'
        )
      ).toContain('changed: true')
    }
  )

  it('distinguishes an Electron runtime patch with the same app version', () => {
    Object.defineProperty(process.versions, 'electron', { value: '41.0.0', configurable: true })
    const previous = materializedRoot()
    Object.defineProperty(process.versions, 'electron', { value: '41.0.1', configurable: true })
    expect(getRelocatedDaemonHost()).toBeNull()
    expect(materializedRoot()).not.toBe(previous)
    expect(existsSync(join(previous, 'Orca.exe'))).toBe(true)
  })

  it('preserves a legacy version directory while publishing the new dependency layout', () => {
    mkdirSync(hostRoot, { recursive: true })
    writeFileSync(join(hostRoot, 'Orca.exe'), 'live-legacy-exe')
    writeFileSync(
      join(hostRoot, '.materialized.json'),
      JSON.stringify({
        version: '9.9.9',
        completedAt: '',
        entryRelPath: 'resources/app.asar.unpacked/out/main/daemon-entry.js'
      })
    )
    expect(getRelocatedDaemonHost()).toBeNull()
    const current = materializedRoot()
    expect(dirname(current)).toBe(hostRoot)
    expect(readFileSync(join(hostRoot, 'Orca.exe'), 'utf8')).toBe('live-legacy-exe')
  })

  it('keeps the copied code ready after the entire install tree disappears', () => {
    const root = materializedRoot()
    rmSync(installDir, { recursive: true, force: true })
    expect(getRelocatedDaemonHost()?.execPath).toBe(join(root, 'Orca.exe'))
  })

  it('retains the build observed by this process when a newer same-version mirror exists', () => {
    const initial = materializedRoot()
    const modulePath = join(installDir, packageRel, 'dist', 'spawn-observer.js')
    const initialBytes = readFileSync(modulePath)
    writeFileSync(modulePath, 'module.exports = { changed: true }')
    expect(materializedRoot()).not.toBe(initial)
    writeFileSync(modulePath, initialBytes)
    expect(getRelocatedDaemonHost()?.execPath).toBe(join(initial, 'Orca.exe'))
    rmSync(installDir, { recursive: true, force: true })
    expect(getRelocatedDaemonHost()?.execPath).toBe(join(initial, 'Orca.exe'))
  })

  it('declines an existing mirror when this installation has never identified its unavailable build', () => {
    const previous = materializedRoot()
    installDir = join(tempDir, 'unobserved-app')
    buildInstallFixture(installDir)
    rmSync(join(installDir, packageRel, 'dist', 'run-process.js'))
    setProcessProp('execPath', join(installDir, 'Orca.exe'))
    setProcessProp('resourcesPath', join(installDir, 'resources'))
    expect(getRelocatedDaemonHost()).toBeNull()
    expect(materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(join(previous, 'Orca.exe'))).toBe(true)
  })

  it('runs emitted bare imports from the relocated entry after removing the install tree', () => {
    const require = createRequire(import.meta.url)
    const actualPackage = dirname(dirname(require.resolve('@orca/process-host')))
    const installedPackage = join(installDir, packageRel)
    cpSync(join(actualPackage, 'package.json'), join(installedPackage, 'package.json'))
    cpSync(join(actualPackage, 'dist'), join(installedPackage, 'dist'), {
      recursive: true,
      dereference: true,
      force: true
    })
    const mainDir = join(installDir, 'resources', 'app.asar.unpacked', 'out', 'main')
    writeFileSync(
      join(mainDir, 'chunks', 'a.js'),
      `module.exports = {
      runner: require('@orca/process-host'),
      observer: require('@orca/process-host/spawn-observer')
    }`
    )
    writeFileSync(
      join(mainDir, 'daemon-entry.js'),
      `
      const assert = require('node:assert/strict')
      const { runner, observer } = require('./chunks/a.js')
      async function main() {
      let observed = 0
      observer.setSpawnObserver(() => { observed += 1 })
      const result = await runner.runProcess({ program: process.execPath, args: ['-e', "process.stdout.write('daemon-closure')"] })
      assert.equal(result.code, 0)
      assert.equal(result.stdout, 'daemon-closure')
      assert.equal(observed, 1)
      observer.setSpawnObserver(null)
      process.stdout.write(result.stdout)
      }
      main().catch(error => { console.error(error); process.exitCode = 1 })
    `
    )
    const host = materializeRelocatedDaemonHost()
    expect(host).not.toBeNull()
    rmSync(installDir, { recursive: true, force: true })
    if (!host) {
      throw new Error('fixture host was not materialized')
    }
    const result = runProcessSync({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? originalExecPath,
      args: [host.entryPath],
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_PATH: undefined,
        NODE_OPTIONS: undefined,
        ORCA_BACKGROUND_LAUNCH: '1'
      },
      timeoutMs: 15_000
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('daemon-closure')
  })
})
