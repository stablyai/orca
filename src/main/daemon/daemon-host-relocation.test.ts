import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable Electron app stub, hoisted so the vi.mock factory can close over it.
const { electronApp } = vi.hoisted(() => ({
  electronApp: {
    isPackaged: false,
    userDataPath: '',
    version: '0.0.0-test',
    getPath: (): string => electronApp.userDataPath,
    getVersion: (): string => electronApp.version
  }
}))

vi.mock('electron', () => ({ app: electronApp }))

import { resolveDaemonHostSourceDir } from './daemon-host-relocation'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-relocation-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})

describe('resolveDaemonHostSourceDir', () => {
  it('returns the daemon-host dir when it holds a node.exe', () => {
    const resources = join(tempDir, 'resources')
    mkdirSync(join(resources, 'daemon-host'), { recursive: true })
    writeFileSync(join(resources, 'daemon-host', 'node.exe'), 'host')
    expect(resolveDaemonHostSourceDir(resources)).toBe(join(resources, 'daemon-host'))
  })

  it('returns null when the daemon-host dir has no node.exe', () => {
    const resources = join(tempDir, 'resources')
    mkdirSync(join(resources, 'daemon-host'), { recursive: true })
    expect(resolveDaemonHostSourceDir(resources)).toBeNull()
  })

  it('returns null when the daemon-host dir is absent', () => {
    expect(resolveDaemonHostSourceDir(join(tempDir, 'resources'))).toBeNull()
  })
})

// process.resourcesPath is typed read-only; point it at a fixture for the test.
function stubResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true, writable: true })
}

// Copies a real node.exe path shape; the win32 guard in the module means this
// only exercises the relocation path on Windows.
describe.runIf(process.platform === 'win32')('installRelocatedDaemonHost', () => {
  const originalResourcesPath = process.resourcesPath

  afterEach(() => {
    stubResourcesPath(originalResourcesPath)
    vi.resetModules()
  })

  it('relocates a bundled node.exe and exposes its userData path', async () => {
    const resources = join(tempDir, 'resources')
    mkdirSync(join(resources, 'daemon-host'), { recursive: true })
    writeFileSync(join(resources, 'daemon-host', 'node.exe'), 'fake-node-host')
    stubResourcesPath(resources)
    electronApp.userDataPath = join(tempDir, 'userData')
    electronApp.version = '9.9.9'
    vi.stubEnv('ORCA_FORCE_DAEMON_HOST_RELOCATION', '1')

    // Fresh module so the one-shot install/singleton state is not carried over.
    vi.resetModules()
    const mod = await import('./daemon-host-relocation')
    mod.installRelocatedDaemonHost()

    const execPath = mod.getRelocatedDaemonHostExecPath()
    expect(execPath).toBe(join(electronApp.userDataPath, 'daemon-host', '9.9.9', 'node.exe'))
    expect(readFileSync(execPath!, 'utf8')).toBe('fake-node-host')
  })

  it('fails open to null when no bundled node.exe is present', async () => {
    const resources = join(tempDir, 'resources')
    mkdirSync(resources, { recursive: true })
    stubResourcesPath(resources)
    electronApp.userDataPath = join(tempDir, 'userData')
    vi.stubEnv('ORCA_FORCE_DAEMON_HOST_RELOCATION', '1')

    vi.resetModules()
    const mod = await import('./daemon-host-relocation')
    mod.installRelocatedDaemonHost()

    expect(mod.getRelocatedDaemonHostExecPath()).toBeNull()
  })
})
