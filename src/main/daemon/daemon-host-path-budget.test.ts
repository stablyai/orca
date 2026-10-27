import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import {
  DAEMON_HOST_NATIVE_PATH_BUDGET,
  deepestDaemonHostNativePathLength,
  type DaemonHostSources
} from './daemon-host-manifest'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import { getRelocatedDaemonHost, materializeRelocatedDaemonHost } from './daemon-host-relocation'

// Adhoc/dev builds carry the longest version strings that reach users.
const LONG_VERSION = '1.4.223-adhoc.20261008042529'
// 20-char SAM name plus a domain suffix: the longest profile folder Windows creates by default.
const LONG_PROFILE_LOCAL_APP_DATA = `C:\\Users\\${'u'.repeat(20)}.${'D'.repeat(15)}\\AppData\\Local`

let tempDir: string
let installDir: string
let localAppDataDir: string
const version = '9.9.9'
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function useLocalAppData(dir: string): void {
  localAppDataDir = dir
  mkdirSync(dir, { recursive: true })
  process.env.LOCALAPPDATA = dir
}

function windowsSources(): DaemonHostSources {
  const appDir = 'C:\\app'
  return {
    appDir,
    execPath: `${appDir}\\Orca.exe`,
    resourcesPath: `${appDir}\\resources`,
    entrySourcePath: `${appDir}\\resources\\app.asar.unpacked\\out\\main\\daemon-entry.js`,
    entryRelPath: 'resources/app.asar.unpacked/out/main/daemon-entry.js',
    windowsProcessTreeDir: `${appDir}\\resources\\node_modules\\@vscode\\windows-process-tree`
  }
}

function materializedHostRoot(): string {
  const host = materializeRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

function publishedBuilds(): string[] {
  const versionRoot = join(localAppDataDir, 'Orca', 'daemon-host-profiles')
  return readdirSync(versionRoot).flatMap((profile) => {
    const dir = join(versionRoot, profile, version)
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('build-')) : []
  })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-path-budget-'))
  installDir = join(tempDir, 'app')
  const userDataDir = join(tempDir, 'userData')
  mkdirSync(userDataDir, { recursive: true })
  useLocalAppData(join(tempDir, 'localAppData'))
  buildInstallFixture(installDir)
  setAppEnvironment({
    getPath: () => userDataDir,
    getAppPath: () => join(installDir, 'resources', 'app.asar'),
    getVersion: () => version,
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  setProcessProp('platform', 'win32')
  setProcessProp('execPath', join(installDir, 'Orca.exe'))
  setProcessProp('resourcesPath', join(installDir, 'resources'))
})

afterEach(() => {
  vi.restoreAllMocks()
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

describe('relocated daemon host path budget', () => {
  it('keeps conpty under the loader limit for a long profile folder and version', () => {
    const hostRel = relative(localAppDataDir, materializedHostRoot())
      .split(/[\\/]/)
      .map((part) => (part === version ? LONG_VERSION : part))
      .join('\\')
    const worstCaseRoot = `${LONG_PROFILE_LOCAL_APP_DATA}\\${hostRel}`
    const deepest = deepestDaemonHostNativePathLength(windowsSources(), worstCaseRoot)
    // Headroom so a layout change can't silently eat the margin; deeper roots take the fallback below.
    expect(deepest).toBeLessThanOrEqual(DAEMON_HOST_NATIVE_PATH_BUDGET - 20)
  })

  it('falls back to the install-dir host instead of copying a host conpty cannot load from', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useLocalAppData(join(tempDir, 'l'.repeat(DAEMON_HOST_NATIVE_PATH_BUDGET - tempDir.length)))
    expect(materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(join(localAppDataDir, 'Orca'))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too deep for conpty.dll'))
  })

  it('replaces a published build whose name pushes conpty over the limit', () => {
    const hostRoot = materializedHostRoot()
    const overBudget = join(dirname(hostRoot), `build-${'x'.repeat(200)}`)
    renameSync(hostRoot, overBudget)
    expect(getRelocatedDaemonHost()).toBeNull()

    expect(materializedHostRoot()).not.toBe(overBudget)
    expect(publishedBuilds()).toHaveLength(2)
  })
})
