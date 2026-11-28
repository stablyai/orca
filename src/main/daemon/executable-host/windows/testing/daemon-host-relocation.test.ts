import {
  chmodSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'

// Pass-through spy: counts synchronous content reads the hash cache makes on main.
const syncReads = vi.hoisted((): { paths: string[] } => ({ paths: [] }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  const readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
    syncReads.paths.push(String(args[0]))
    return fs.readFileSync(...args)
  }
  return { ...fs, default: { ...fs, readFileSync }, readFileSync }
})

import { setAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'

const hostApp = {
  isPackaged: true,
  userDataPath: '',
  appPath: '',
  version: '9.9.9'
}

function installHostApp(): void {
  setAppEnvironment({
    getPath: () => hostApp.userDataPath,
    getAppPath: () => hostApp.appPath,
    getVersion: () => hostApp.version,
    isPackaged: () => hostApp.isPackaged,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
}
import { createHash } from 'node:crypto'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import { buildDaemonHostManifest, executeManifest, toPosixRelative } from '../daemon-host-manifest'
import {
  daemonHostCodeMatcher,
  processHostExportsPresentAsync
} from '../daemon-host-inventory-roots'
import { removeDaemonHostTree } from '../daemon-host-tree-walk'
import { collectPinnedDaemonVersions } from '../daemon-host-pinned-versions'
import {
  getDaemonHostRootDir,
  getRelocatedDaemonHost,
  materializeRelocatedDaemonHost
} from '../daemon-host-relocation'
import { pruneOldDaemonHosts } from '../daemon-host-prune'

let tempDir: string
let installDir: string
let userDataDir: string
let localAppDataDir: string
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function relocatedHostRoot(): string {
  const host = getRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

const PROCESS_TREE_ADDON_REL = join(
  'resources',
  'node_modules',
  '@vscode',
  'windows-process-tree',
  'build',
  'Release',
  'windows_process_tree.node'
)

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-relocation-'))
  installDir = join(tempDir, 'app')
  userDataDir = join(tempDir, 'userData')
  mkdirSync(userDataDir, { recursive: true })
  localAppDataDir = join(tempDir, 'localAppData')
  mkdirSync(localAppDataDir, { recursive: true })
  process.env.LOCALAPPDATA = localAppDataDir
  buildInstallFixture(installDir)
  hostApp.isPackaged = true
  hostApp.userDataPath = userDataDir
  hostApp.appPath = join(installDir, 'resources', 'app.asar')
  hostApp.version = '9.9.9'
  installHostApp()
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
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // Best-effort
  }
})

describe('materializeRelocatedDaemonHost', () => {
  it('reuses a cold copy fingerprinted from its own bytes instead of copying again', async () => {
    const cold = await materializeRelocatedDaemonHost()
    const warm = await materializeRelocatedDaemonHost()
    expect(cold).not.toBeNull()
    expect(warm).toEqual(cold)
    expect(
      readdirSync(dirname(dirname(cold!.execPath))).filter((n) => n.startsWith('build-'))
    ).toHaveLength(1)
  })

  it('leaves the sync lookup no source code to reread after a cold copy', async () => {
    expect(await materializeRelocatedDaemonHost()).not.toBeNull()
    syncReads.paths.length = 0
    expect(getRelocatedDaemonHost()).not.toBeNull()
    const sourceCodeReads = syncReads.paths.filter(
      (path) => path.startsWith(installDir) && path.endsWith('.js')
    )
    expect(sourceCodeReads).toEqual([])
  })

  it('rematerializes a host whose copied addon went missing', async () => {
    await materializeRelocatedDaemonHost()
    const dest = relocatedHostRoot()
    const relocatedAddon = join(dest, PROCESS_TREE_ADDON_REL)

    rmSync(relocatedAddon)
    const sentinel = join(dest, 'sentinel.txt')
    writeFileSync(sentinel, 'keep')

    const rebuilt = await materializeRelocatedDaemonHost()
    expect(rebuilt).not.toBeNull()
    expect(dirname(rebuilt!.execPath)).not.toBe(dest)
    expect(readFileSync(join(dirname(rebuilt!.execPath), PROCESS_TREE_ADDON_REL), 'utf8')).toBe(
      'process-tree-native'
    )
    expect(existsSync(sentinel)).toBe(true)
  })

  it('refuses to copy anything when the install lost the process-tree binary', async () => {
    // Validate missing sources before an expensive copy that the mirror check would reject.
    rmSync(join(installDir, PROCESS_TREE_ADDON_REL))

    expect(await materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(getDaemonHostRootDir())).toBe(false)
  })

  it('refuses a cold copy when the install lost the registry addon', async () => {
    rmSync(
      join(
        installDir,
        'resources',
        'node_modules',
        '@orca',
        'windows-registry',
        'build',
        'Release',
        'orca_windows_registry.node'
      )
    )

    expect(await materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(getDaemonHostRootDir())).toBe(false)
  })

  it('fails open on a missing required input, leaving no dest or staging dir', async () => {
    rmSync(join(installDir, 'resources', 'node_modules', 'node-pty'), {
      recursive: true,
      force: true
    })
    const result = await materializeRelocatedDaemonHost()
    expect(result).toBeNull()
    const hostRoot = getDaemonHostRootDir()
    const remaining = existsSync(hostRoot) ? readdirSync(hostRoot) : []
    expect(remaining).toEqual([])
  })
})

describe('executeManifest', () => {
  it('rejects a copy whose code no longer matches the fingerprint', async () => {
    const entry = join(
      installDir,
      'resources',
      'app.asar.unpacked',
      'out',
      'main',
      'daemon-entry.js'
    )
    const op = { sourcePath: entry, destRel: 'entry.js', kind: 'file' as const }
    const staging = join(tempDir, 'staging')
    const fingerprinted = createHash('sha256').update('entry').digest('hex')

    await executeManifest([op], staging, {
      isCode: (rel) => rel === 'entry.js',
      expected: new Map([['entry.js', fingerprinted]])
    })
    expect(readFileSync(join(staging, 'entry.js'), 'utf8')).toBe('entry')

    writeFileSync(entry, 'changed after fingerprinting')
    await expect(
      executeManifest([op], join(tempDir, 'staging-2'), {
        isCode: (rel) => rel === 'entry.js',
        expected: new Map([['entry.js', fingerprinted]])
      })
    ).rejects.toThrow('code changed while copying')
  })
})

describe('executeManifest mixed revisions', () => {
  it('rejects a fresh copy when a code file it already copied changes mid-copy', async () => {
    const codeDir = join(tempDir, 'code')
    mkdirSync(codeDir)
    for (const name of ['a.js', 'b.js', 'c.js']) {
      writeFileSync(join(codeDir, name), `revision-a ${name}`)
    }
    let calls = 0
    const isCode = (rel: string): boolean => {
      calls += 1
      // Calls 1-3 come from listing and 4-6 from copying; the copy of the third file starts only after another finished.
      if (calls === 6) {
        writeFileSync(join(codeDir, 'a.js'), 'revision-b, a longer a.js')
        writeFileSync(join(codeDir, 'b.js'), 'revision-b, a longer b.js')
      }
      return rel.startsWith('code/')
    }
    await expect(
      executeManifest(
        [{ sourcePath: codeDir, destRel: 'code', kind: 'dir' }],
        join(tempDir, 'mixed'),
        {
          isCode
        }
      )
    ).rejects.toThrow('code changed while copying')
  })
})

describe('executeManifest added files', () => {
  it('rejects a fresh copy when a code file appears after listing', async () => {
    const codeDir = join(tempDir, 'code')
    mkdirSync(codeDir)
    writeFileSync(join(codeDir, 'entry.js'), 'require("./chunk.js")')
    let calls = 0
    const isCode = (rel: string): boolean => {
      calls += 1
      // Calls 1-2 list and copy entry.js; call 3 picks the code dirs to re-list after the copy.
      if (calls === 3) {
        writeFileSync(join(codeDir, 'chunk.js'), 'module.exports = {}')
      }
      return rel.startsWith('code')
    }
    await expect(
      executeManifest(
        [{ sourcePath: codeDir, destRel: 'code', kind: 'dir' }],
        join(tempDir, 'added'),
        { isCode }
      )
    ).rejects.toThrow('code changed while copying')
  })
})

describe('executeManifest optional code roots', () => {
  it('rejects a fresh copy when an absent optional code folder appears mid-copy', async () => {
    const entry = join(tempDir, 'entry.js')
    writeFileSync(entry, 'entry')
    const chunks = join(tempDir, 'chunks')
    let calls = 0
    const isCode = (): boolean => {
      calls += 1
      // Call 2 copies entry.js, after chunks/ was found absent.
      if (calls === 2) {
        mkdirSync(chunks)
        writeFileSync(join(chunks, 'b.js'), 'chunk')
      }
      return true
    }
    await expect(
      executeManifest(
        [
          { sourcePath: entry, destRel: 'entry.js', kind: 'file' },
          { sourcePath: chunks, destRel: 'chunks', kind: 'dir', optional: true }
        ],
        join(tempDir, 'optional'),
        { isCode }
      )
    ).rejects.toThrow('code changed while copying')
  })
})

describe('daemon-host copy with the production manifest', () => {
  it('rejects a cold copy when the absent chunks folder appears mid-copy', async () => {
    const mainDir = join(installDir, 'resources', 'app.asar.unpacked', 'out', 'main')
    const chunks = join(mainDir, 'chunks')
    rmSync(chunks, { recursive: true, force: true })
    const entrySourcePath = join(mainDir, 'daemon-entry.js')
    const sources = {
      appDir: installDir,
      execPath: join(installDir, 'Orca.exe'),
      resourcesPath: join(installDir, 'resources'),
      entrySourcePath,
      entryRelPath: toPosixRelative(installDir, entrySourcePath),
      windowsProcessTreeDir: join(
        installDir,
        'resources',
        'node_modules',
        '@vscode',
        'windows-process-tree'
      )
    }
    const isProductionCode = daemonHostCodeMatcher(sources)
    let entryChecks = 0
    const isCode = (rel: string): boolean => {
      // The second entry check is the copy loop, after chunks/ was found absent.
      if (rel === sources.entryRelPath && ++entryChecks === 2) {
        mkdirSync(chunks)
        writeFileSync(join(chunks, 'b.js'), 'chunk')
      }
      return isProductionCode(rel)
    }
    await expect(
      executeManifest(buildDaemonHostManifest(sources), join(tempDir, 'prod-staging'), { isCode })
    ).rejects.toThrow('code changed while copying')
  })
})

describe('processHostExportsPresentAsync', () => {
  it('rejects a staged process-host copy missing an export the install declares', async () => {
    const installed = join(installDir, 'resources', 'node_modules', '@orca', 'process-host')
    const staged = join(tempDir, 'staged-process-host')
    mkdirSync(join(staged, 'dist'), { recursive: true })
    writeFileSync(join(staged, 'package.json'), readFileSync(join(installed, 'package.json')))
    writeFileSync(join(staged, 'dist', 'run-process.js'), 'copied')

    expect(await processHostExportsPresentAsync(installed)).toBe(true)
    expect(await processHostExportsPresentAsync(staged)).toBe(false)
  })
})

describe('executeManifest missing sources', () => {
  // Electron's Windows Node can turn a failed opendir into a null handle (#50997); missing folders must reject.
  it('rejects a missing required folder and skips a missing optional one', async () => {
    const missing = join(installDir, 'resources', 'no-such-folder')
    const staging = join(tempDir, 'staging-missing')
    await expect(
      executeManifest([{ sourcePath: missing, destRel: 'required', kind: 'dir' }], staging)
    ).rejects.toThrow('missing required input')
    await executeManifest(
      [{ sourcePath: missing, destRel: 'optional', kind: 'dir', optional: true }],
      staging
    )
    expect(existsSync(join(staging, 'optional'))).toBe(false)
    await expect(removeDaemonHostTree(missing)).rejects.toThrow()
  })
})

describe('removeDaemonHostTree', () => {
  function hostWithCopy(): string {
    const host = join(tempDir, 'host')
    mkdirSync(join(host, 'nested', 'empty'), { recursive: true })
    writeFileSync(join(host, 'nested', 'file.txt'), 'copy')
    return host
  }

  it('removes a copy without following a junction out of it', async () => {
    const outsideDir = join(tempDir, 'install-dir')
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'inner.txt'), 'keep')
    const host = hostWithCopy()
    symlinkSync(outsideDir, join(host, 'nested', 'dir-link'), 'junction')

    await removeDaemonHostTree(host)

    expect(existsSync(host)).toBe(false)
    expect(readFileSync(join(outsideDir, 'inner.txt'), 'utf8')).toBe('keep')
  })

  // POSIX unlinks read-only files anyway; only Windows refuses them.
  it.runIf(process.platform === 'win32')('removes a copy holding a read-only file', async () => {
    const host = hostWithCopy()
    chmodSync(join(host, 'nested', 'file.txt'), 0o444)

    await removeDaemonHostTree(host)

    expect(existsSync(host)).toBe(false)
  })

  // File symlinks need Developer Mode or SeCreateSymbolicLinkPrivilege on Windows; junctions don't.
  it.skipIf(process.platform === 'win32')(
    'removes a copy without following a file link out of it',
    async () => {
      const outside = join(tempDir, 'install-file.txt')
      writeFileSync(outside, 'keep')
      const host = hostWithCopy()
      symlinkSync(outside, join(host, 'file-link'))

      await removeDaemonHostTree(host)

      expect(existsSync(host)).toBe(false)
      expect(readFileSync(outside, 'utf8')).toBe('keep')
    }
  )
})

// Age beyond the publication window so quarantine sees a settled corrupt record.
function ageRecordPastQuarantineFloor(recordPath: string): void {
  const aged = new Date(Date.now() - 5 * 60_000)
  utimesSync(recordPath, aged, aged)
}

describe('pruneOldDaemonHosts', () => {
  it('removes unpinned non-current version dirs, keeping current and pinned', async () => {
    const root = getDaemonHostRootDir()
    for (const v of ['9.9.9', '1.0.0', '2.0.0']) {
      mkdirSync(join(root, v), { recursive: true })
    }
    await pruneOldDaemonHosts({
      status: 'complete',
      versionLiveness: new Map([['2.0.0', { status: 'live' }]])
    })
    expect(existsSync(join(root, '9.9.9'))).toBe(true)
    expect(existsSync(join(root, '2.0.0'))).toBe(true)
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
  })

  it('keeps a version pinned after the snapshot when the removal-time recheck sees it live', async () => {
    const root = getDaemonHostRootDir()
    for (const v of ['9.9.9', '1.0.0', '2.0.0']) {
      mkdirSync(join(root, v), { recursive: true })
    }
    const recheck = vi.fn(async () => ({
      status: 'complete' as const,
      versionLiveness: new Map([['1.0.0', { status: 'live' as const }]])
    }))
    await pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() }, recheck)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    expect(existsSync(join(root, '2.0.0'))).toBe(false)
    expect(recheck).toHaveBeenCalled()
  })

  it('keeps a host when its pid liveness query is permission denied', async () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '8.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v8.pid'),
      JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '8.0.0' })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' })
    })

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'complete',
      versionLiveness: new Map([['8.0.0', { status: 'live' }]])
    })
    await pruneOldDaemonHosts(evidence)

    expect(existsSync(join(root, '8.0.0'))).toBe(true)
    killSpy.mockRestore()
  })

  it('keeps a host when its pid liveness query is unavailable', async () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '7.0.0'), { recursive: true })
    mkdirSync(join(root, '6.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v7.pid'),
      JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '7.0.0' })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    })

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'complete',
      versionLiveness: new Map([
        ['7.0.0', { status: 'unverifiable', reason: 'the daemon process could not be queried' }]
      ])
    })
    await pruneOldDaemonHosts(evidence)

    expect(existsSync(join(root, '7.0.0'))).toBe(true)
    expect(existsSync(join(root, '6.0.0'))).toBe(false)
    killSpy.mockRestore()
  })

  it('skips pruning when the runtime directory cannot be read', async () => {
    const root = getDaemonHostRootDir()
    mkdirSync(join(root, '1.0.0'), { recursive: true })

    const evidence = collectPinnedDaemonVersions(join(userDataDir, 'daemon-never-created'))

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon runtime directory could not be read'
    })
    await pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })

  it('keeps a version live when any of its pid records is live', async () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '7.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // A live daemon must pin its version regardless of directory scan order.
    writeFileSync(
      join(runtimeDir, 'daemon-v7.pid'),
      JSON.stringify({ pid: 5001, startedAtMs: null, appVersion: '7.0.0' })
    )
    writeFileSync(
      join(runtimeDir, 'daemon-v8.pid'),
      JSON.stringify({ pid: 5002, startedAtMs: null, appVersion: '7.0.0' })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 5001) {
        return true
      }
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'complete',
      versionLiveness: new Map([['7.0.0', { status: 'live' }]])
    })
    await pruneOldDaemonHosts(evidence)

    expect(existsSync(join(root, '7.0.0'))).toBe(true)
    killSpy.mockRestore()
  })

  it('quarantines a record torn inside the pid digits', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // A torn PID prefix can name an unrelated process.
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '{"pid":123')
    ageRecordPastQuarantineFloor(pidPath)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be parsed and was quarantined: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(false)
    expect(readFileSync(join(runtimeDir, 'daemon-v7.pid.corrupt'), 'utf8')).toBe('{"pid":123')
    warnSpy.mockRestore()
    killSpy.mockRestore()
  })

  it('never quarantines a corrupt record that was just written', async () => {
    // wx creates the record before writing it; a fresh empty file may still belong to a live publisher.
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason:
        'the daemon pid file could not be parsed and was written too recently to quarantine: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    expect(existsSync(join(runtimeDir, 'daemon-v7.pid.corrupt'))).toBe(false)
    await pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('vetoes pruning while a pid salvaged from a corrupt record still answers', async () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // The complete PID still answers; a torn version field cannot justify quarantining its record.
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '{"pid": 4242, "startedAtMs": 17')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason:
        'the daemon pid file could not be parsed and salvaged pid 4242 may still be running: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    await pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    warnSpy.mockRestore()
    killSpy.mockRestore()
  })

  it('quarantines a corrupt record naming no live pid so pruning resumes next launch', async () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, 'not a daemon record')
    ageRecordPastQuarantineFloor(pidPath)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be parsed and was quarantined: daemon-v7.pid'
    })
    await pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    expect(existsSync(pidPath)).toBe(false)
    expect(readFileSync(join(runtimeDir, 'daemon-v7.pid.corrupt'), 'utf8')).toBe(
      'not a daemon record'
    )

    const nextEvidence = collectPinnedDaemonVersions(runtimeDir)
    expect(nextEvidence).toEqual({ status: 'complete', versionLiveness: new Map() })
    await pruneOldDaemonHosts(nextEvidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('vetoes pruning without quarantine when a pid record cannot be read', async (ctx) => {
    // process.platform is mocked; permission fixtures depend on the actual host.
    if (originalPlatform === 'win32') {
      return ctx.skip()
    }
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '1.0.0' }))
    chmodSync(pidPath, 0o000)
    try {
      readFileSync(pidPath)
      return ctx.skip() // Running as root: the permission bit cannot make the read fail.
    } catch {}

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    // Transient read failures veto pruning without quarantining the record.
    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be read: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    await pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })

  it('reclaims nothing for a packaged host with no asar root (orcad on win32)', async () => {
    const root = getDaemonHostRootDir()
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    hostApp.appPath = join(installDir, 'resources', 'app')
    installHostApp()
    await pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() })
    // Node hosts do not own this Electron runtime layout and cannot authorize its cleanup.
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })
})

describe('collectPinnedDaemonVersions', () => {
  it('pins the app version of a live daemon pid file and skips dead ones', () => {
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v4.pid'),
      JSON.stringify({ pid: process.pid, startedAtMs: null, appVersion: '7.0.0' })
    )
    writeFileSync(
      join(runtimeDir, 'daemon-v3.pid'),
      JSON.stringify({ pid: 2147483646, startedAtMs: null, appVersion: '6.0.0' })
    )
    const pinned = collectPinnedDaemonVersions(runtimeDir)
    expect(pinned).toEqual({
      status: 'complete',
      versionLiveness: new Map([
        ['7.0.0', { status: 'live' }],
        ['6.0.0', { status: 'exited' }]
      ])
    })
  })
})
