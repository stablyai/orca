import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import { getRelocatedDaemonHost, materializeRelocatedDaemonHost } from './daemon-host-relocation'

const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA
let tempDir: string
let installDir: string
let directEntry: string

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-entry-layout-'))
  installDir = join(tempDir, 'app')
  buildInstallFixture(installDir)
  const unpacked = join(installDir, 'resources', 'app.asar.unpacked')
  directEntry = join(unpacked, 'daemon-entry.js')
  const nestedEntry = join(unpacked, 'out', 'main', 'daemon-entry.js')
  cpSync(nestedEntry, directEntry)
  process.env.LOCALAPPDATA = join(tempDir, 'localAppData')
  setProcessProp('platform', 'win32')
  setProcessProp('execPath', join(installDir, 'Orca.exe'))
  setProcessProp('resourcesPath', join(installDir, 'resources'))
  setAppEnvironment({
    getPath: () => join(tempDir, 'userData'),
    getAppPath: () => join(installDir, 'resources', 'app.asar'),
    getVersion: () => '9.9.9',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
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
  rmSync(tempDir, { recursive: true, force: true })
})

describe('daemon-host entry layout after source removal', () => {
  it('keeps the observed direct-entry mirror after the entire install disappears', () => {
    const host = materializeRelocatedDaemonHost()
    expect(host).not.toBeNull()
    expect(host?.entryPath).toBe(
      join(dirname(host?.execPath ?? ''), 'resources', 'app.asar.unpacked', 'daemon-entry.js')
    )
    rmSync(installDir, { recursive: true, force: true })

    expect(getRelocatedDaemonHost()).toEqual(host)
    expect(materializeRelocatedDaemonHost()).toEqual(host)
    expect(existsSync(host?.entryPath ?? '')).toBe(true)
  })

  it('validates a present alternate layout and preserves that newer observed build', () => {
    const direct = materializeRelocatedDaemonHost()
    expect(direct).not.toBeNull()
    rmSync(directEntry)

    expect(getRelocatedDaemonHost()).toBeNull()
    const nested = materializeRelocatedDaemonHost()
    expect(nested).not.toBeNull()
    expect(nested?.entryPath).toBe(
      join(
        dirname(nested?.execPath ?? ''),
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'daemon-entry.js'
      )
    )
    expect(nested?.execPath).not.toBe(direct?.execPath)
    rmSync(installDir, { recursive: true, force: true })

    expect(getRelocatedDaemonHost()).toEqual(nested)
    expect(materializeRelocatedDaemonHost()).toEqual(nested)
    expect(existsSync(direct?.entryPath ?? '')).toBe(true)
  })

  it('refuses to reuse the observed fingerprint for an incomplete alternate layout', () => {
    const direct = materializeRelocatedDaemonHost()
    expect(direct).not.toBeNull()
    rmSync(directEntry)
    rmSync(
      join(
        installDir,
        'resources',
        'node_modules',
        '@orca',
        'process-host',
        'dist',
        'run-process.js'
      )
    )

    expect(getRelocatedDaemonHost()).toBeNull()
    expect(materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(direct?.entryPath ?? '')).toBe(true)
  })
})
