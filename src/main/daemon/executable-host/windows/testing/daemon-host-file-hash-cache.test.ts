import type * as NodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../../../shared/app-environment'
import { resetDaemonHostFileHashCacheForTests } from '../daemon-host-file-hash-cache'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import { getRelocatedDaemonHost, materializeRelocatedDaemonHost } from '../daemon-host-relocation'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

function codeReads(): unknown[] {
  return vi
    .mocked(readFileSync)
    .mock.calls.map(([path]) => path)
    .filter((path) => typeof path === 'string' && (path.endsWith('.js') || path.endsWith('.node')))
}

const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA
const chunkRel = join('resources', 'app.asar.unpacked', 'out', 'main', 'chunks', 'a.js')
let tempDir: string
let installDir: string

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

const PINNED_MTIME_SECONDS = 1_700_000_000

// Whole-second mtime so restoring it is exact; only identity/ctime can then reveal the edit.
function pinMtime(path: string): void {
  utimesSync(path, PINNED_MTIME_SECONDS, PINNED_MTIME_SECONDS)
}

async function rewriteKeepingSizeAndMtime(path: string, contents: string): Promise<void> {
  const before = statSync(path)
  expect(contents.length).toBe(before.size)
  // Allow ctime to tick before restoring mtime on the same-size rewrite.
  await new Promise((resolve) => setTimeout(resolve, 20))
  writeFileSync(path, contents)
  pinMtime(path)
  const after = statSync(path)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(after.ctimeMs).not.toBe(before.ctimeMs)
}

beforeEach(() => {
  resetDaemonHostFileHashCacheForTests()
  vi.mocked(readFileSync).mockClear()
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-hash-cache-'))
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

describe('daemon-host code hash cache', () => {
  it('detects a same-size source edit that restores mtime', async () => {
    pinMtime(join(installDir, chunkRel))
    const root = materializedRoot()
    await rewriteKeepingSizeAndMtime(join(installDir, chunkRel), 'chunX')

    expect(getRelocatedDaemonHost()).toBeNull()
    expect(codeReads()).toContain(join(installDir, chunkRel))
    const rebuilt = materializedRoot()
    expect(rebuilt).not.toBe(root)
    expect(readFileSync(join(rebuilt, chunkRel), 'utf8')).toBe('chunX')
  })

  it('detects a same-size mirror edit that restores mtime', async () => {
    const root = materializedRoot()
    pinMtime(join(root, chunkRel))
    expect(getRelocatedDaemonHost()).not.toBeNull()
    await rewriteKeepingSizeAndMtime(join(root, chunkRel), 'chunX')

    expect(getRelocatedDaemonHost()).toBeNull()
  })
})
