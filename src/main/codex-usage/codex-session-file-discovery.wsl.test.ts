import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import { join } from 'node:path'

const WSL_UNC_PREFIX = '\\\\wsl.localhost\\'
const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const DEBIAN_HOME = '\\\\wsl.localhost\\Debian\\home\\leo'
const UBUNTU_MANAGED_SESSIONS =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions'
const UBUNTU_SYSTEM_SESSIONS = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions'
const DEBIAN_MANAGED_SESSIONS =
  '\\\\wsl.localhost\\Debian\\home\\leo\\.local\\share\\orca\\codex-runtime-home\\home\\sessions'
const DEBIAN_SYSTEM_SESSIONS = '\\\\wsl.localhost\\Debian\\home\\leo\\.codex\\sessions'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

const wslMocks = vi.hoisted(() => ({
  runningDistros: [] as string[],
  homesByDistro: new Map<string, string>(),
  attemptedReadDirs: [] as string[],
  failingReadDirs: new Set<string>()
}))

vi.mock('../wsl', () => ({
  listRunningWslDistrosAsync: vi.fn(),
  getWslHomeAsync: vi.fn()
}))

// Why: UNC fixtures have no backing distro, so WSL reads come from an in-memory
// tree; every other path goes to the real filesystem untouched.
type FakeWslNode = FakeWslDir | 'file'
type FakeWslDir = {
  entries: Map<string, FakeWslNode>
}
const fakeWslDirs = new Map<string, FakeWslDir>()

function normalizeFakeWslPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

function registerFakeWslDir(dirPath: string): FakeWslDir {
  const key = normalizeFakeWslPath(dirPath)
  let dir = fakeWslDirs.get(key)
  if (!dir) {
    dir = { entries: new Map<string, FakeWslNode>() }
    fakeWslDirs.set(key, dir)
  }
  return dir
}

function addFakeWslFile(sessionsRoot: string, relativePath: string): void {
  const segments = relativePath.split('/')
  const fileName = segments.pop()
  if (!fileName) {
    throw new Error(`empty relative path: ${relativePath}`)
  }
  let currentPath = sessionsRoot
  let dir = registerFakeWslDir(currentPath)
  for (const segment of segments) {
    currentPath = `${currentPath}\\${segment}`
    const next = dir.entries.get(segment)
    if (next && next !== 'file') {
      dir = next
      continue
    }
    // Why: intermediate directories must be resolvable from the top-level
    // registry too, or a readdir of them rejects and voids the whole lane.
    const created = registerFakeWslDir(currentPath)
    dir.entries.set(segment, created)
    dir = created
  }
  dir.entries.set(fileName, 'file')
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromisesModule>()
  const actualReaddir = actual.readdir.bind(actual) as (
    pathValue: string,
    options?: { withFileTypes?: boolean }
  ) => Promise<unknown>
  return {
    ...actual,
    readdir: (async (pathValue: string, options?: { withFileTypes?: boolean }) => {
      if (!pathValue.startsWith(WSL_UNC_PREFIX)) {
        return actualReaddir(pathValue, options)
      }
      const key = normalizeFakeWslPath(pathValue)
      wslMocks.attemptedReadDirs.push(pathValue)
      if (wslMocks.failingReadDirs.has(key)) {
        throw Object.assign(new Error(`EACCES: ${pathValue}`), { code: 'EACCES' })
      }
      const dir = fakeWslDirs.get(key)
      if (!dir) {
        throw Object.assign(new Error(`ENOENT: ${pathValue}`), { code: 'ENOENT' })
      }
      if (options?.withFileTypes) {
        return [...dir.entries.entries()].map(([name, node]) => ({
          name,
          isDirectory: () => node !== 'file',
          isFile: () => node === 'file',
          isSymbolicLink: () => false
        }))
      }
      return [...dir.entries.keys()]
    }) as unknown as typeof actual.readdir,
    // Why: stat and realpath must never reach the real WSL 9p provider for
    // fixtures; on a host that actually has the distro they would stall or boot
    // it. ino 0 pushes alias identity onto the normalized-path fallback.
    stat: (async (pathValue: string) => {
      const node = pathValue.startsWith(WSL_UNC_PREFIX) ? resolveFakeWslNode(pathValue) : undefined
      if (node !== 'file') {
        return actual.stat(pathValue)
      }
      return {
        dev: 0,
        ino: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 2,
        mtimeMs: 0
      }
    }) as unknown as typeof actual.stat,
    realpath: (async (pathValue: string) => {
      throw Object.assign(new Error(`ENOENT: ${pathValue}`), { code: 'ENOENT' })
    }) as unknown as typeof actual.realpath
  }
})

function resolveFakeWslNode(pathValue: string): FakeWslNode | undefined {
  const segments = normalizeFakeWslPath(pathValue).split('/')
  const fileName = segments.pop()
  if (!fileName || segments.length === 0) {
    return undefined
  }
  return fakeWslDirs.get(segments.join('/'))?.entries.get(fileName)
}

import {
  getWslCodexSessionDirectories,
  listCodexSessionFiles
} from './codex-session-file-discovery'
import { getWslHomeAsync, listRunningWslDistrosAsync } from '../wsl'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function useDistro(distro: string, home: string | null): void {
  wslMocks.runningDistros.push(distro)
  if (home !== null) {
    wslMocks.homesByDistro.set(distro, home)
  }
}

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined
let runtimeSessionsDir: string
let systemSessionsDir: string

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
  systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
  wslMocks.runningDistros = []
  wslMocks.homesByDistro.clear()
  wslMocks.attemptedReadDirs.length = 0
  wslMocks.failingReadDirs.clear()
  fakeWslDirs.clear()
  vi.mocked(listRunningWslDistrosAsync).mockImplementation(async () => [...wslMocks.runningDistros])
  vi.mocked(getWslHomeAsync).mockImplementation(
    async (distro: string) => wslMocks.homesByDistro.get(distro) ?? null
  )
  setPlatform('win32')
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  setPlatform(realPlatform)
  vi.clearAllMocks()
})

describe('getWslCodexSessionDirectories', () => {
  it('returns no WSL directories on a non-windows host', async () => {
    setPlatform('darwin')

    await expect(getWslCodexSessionDirectories()).resolves.toEqual([])
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
    expect(getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('returns no WSL directories when no distro is running', async () => {
    await expect(getWslCodexSessionDirectories()).resolves.toEqual([])
    expect(listRunningWslDistrosAsync).toHaveBeenCalledTimes(1)
    expect(getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('skips a running distro whose home cannot be resolved', async () => {
    useDistro('Ubuntu', null)

    await expect(getWslCodexSessionDirectories()).resolves.toEqual([])
    expect(getWslHomeAsync).toHaveBeenCalledWith('Ubuntu')
  })

  it('emits the managed lane before the system lane per running distro', async () => {
    useDistro('Ubuntu', UBUNTU_HOME)
    useDistro('Debian', DEBIAN_HOME)

    await expect(getWslCodexSessionDirectories()).resolves.toEqual([
      UBUNTU_MANAGED_SESSIONS,
      UBUNTU_SYSTEM_SESSIONS,
      DEBIAN_MANAGED_SESSIONS,
      DEBIAN_SYSTEM_SESSIONS
    ])
  })

  it('dedupes identical lanes resolved from different distros', async () => {
    useDistro('Ubuntu', UBUNTU_HOME)
    useDistro('Ubuntu-22.04', UBUNTU_HOME)

    await expect(getWslCodexSessionDirectories()).resolves.toEqual([
      UBUNTU_MANAGED_SESSIONS,
      UBUNTU_SYSTEM_SESSIONS
    ])
  })
})

describe('listCodexSessionFiles across windows and wsl lanes', () => {
  it('walks the wsl lanes alongside the windows lanes', async () => {
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const runtimeSessionPath = join(runtimeSessionsDir, 'runtime.jsonl')
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    writeFileSync(runtimeSessionPath, '{}\n', 'utf-8')
    writeFileSync(systemSessionPath, '{}\n', 'utf-8')
    useDistro('Ubuntu', UBUNTU_HOME)
    useDistro('Debian', DEBIAN_HOME)
    addFakeWslFile(UBUNTU_MANAGED_SESSIONS, 'rollout-ubuntu.jsonl')
    addFakeWslFile(DEBIAN_MANAGED_SESSIONS, 'rollout-debian.jsonl')
    addFakeWslFile(DEBIAN_SYSTEM_SESSIONS, 'rollout-debian-system.jsonl')

    const files = await listCodexSessionFiles()

    expect(files).toEqual(
      [
        runtimeSessionPath,
        systemSessionPath,
        join(UBUNTU_MANAGED_SESSIONS, 'rollout-ubuntu.jsonl'),
        join(DEBIAN_MANAGED_SESSIONS, 'rollout-debian.jsonl'),
        join(DEBIAN_SYSTEM_SESSIONS, 'rollout-debian-system.jsonl')
      ].sort()
    )
  })

  it('keeps scanning other lanes when one wsl lane fails to read', async () => {
    useDistro('Ubuntu', UBUNTU_HOME)
    useDistro('Debian', DEBIAN_HOME)
    addFakeWslFile(UBUNTU_MANAGED_SESSIONS, 'rollout-ubuntu.jsonl')
    addFakeWslFile(DEBIAN_MANAGED_SESSIONS, 'rollout-debian.jsonl')
    addFakeWslFile(DEBIAN_SYSTEM_SESSIONS, 'rollout-debian-system.jsonl')
    wslMocks.failingReadDirs.add(normalizeFakeWslPath(UBUNTU_SYSTEM_SESSIONS))

    const files = await listCodexSessionFiles()

    // Both failing Ubuntu lanes were attempted, yet Debian survived intact.
    expect(wslMocks.attemptedReadDirs).toContain(UBUNTU_MANAGED_SESSIONS)
    expect(wslMocks.attemptedReadDirs).toContain(UBUNTU_SYSTEM_SESSIONS)
    expect(wslMocks.attemptedReadDirs).toContain(DEBIAN_SYSTEM_SESSIONS)
    expect(files).toEqual(
      [
        join(UBUNTU_MANAGED_SESSIONS, 'rollout-ubuntu.jsonl'),
        join(DEBIAN_MANAGED_SESSIONS, 'rollout-debian.jsonl'),
        join(DEBIAN_SYSTEM_SESSIONS, 'rollout-debian-system.jsonl')
      ].sort()
    )
  })

  it('counts a hard-linked rollout once with the managed copy winning', async () => {
    useDistro('Ubuntu', UBUNTU_HOME)
    addFakeWslFile(UBUNTU_MANAGED_SESSIONS, 'twin.jsonl')
    addFakeWslFile(UBUNTU_MANAGED_SESSIONS, 'nested/twin-deep.jsonl')
    addFakeWslFile(UBUNTU_SYSTEM_SESSIONS, 'twin.jsonl')
    addFakeWslFile(UBUNTU_SYSTEM_SESSIONS, 'nested/twin-deep.jsonl')
    addFakeWslFile(UBUNTU_SYSTEM_SESSIONS, 'only-system.jsonl')

    const files = await listCodexSessionFiles()

    expect(files).toEqual(
      [
        join(UBUNTU_MANAGED_SESSIONS, 'twin.jsonl'),
        join(UBUNTU_MANAGED_SESSIONS, 'nested', 'twin-deep.jsonl'),
        join(UBUNTU_SYSTEM_SESSIONS, 'only-system.jsonl')
      ].sort()
    )
    const survivingTwin = files.find((filePath) => filePath.endsWith('twin.jsonl'))
    expect(survivingTwin).toBeDefined()
    expect(survivingTwin!.startsWith(UBUNTU_MANAGED_SESSIONS)).toBe(true)
  })

  it('keeps same-named rollouts across different distros out of each dedupe scope', async () => {
    useDistro('Ubuntu', UBUNTU_HOME)
    useDistro('Debian', DEBIAN_HOME)
    addFakeWslFile(UBUNTU_MANAGED_SESSIONS, 'shared-name.jsonl')
    addFakeWslFile(UBUNTU_SYSTEM_SESSIONS, 'unique-ubuntu.jsonl')
    addFakeWslFile(DEBIAN_MANAGED_SESSIONS, 'shared-name.jsonl')
    addFakeWslFile(DEBIAN_SYSTEM_SESSIONS, 'unique-debian.jsonl')

    const files = await listCodexSessionFiles()

    expect(files).toEqual(
      [
        join(UBUNTU_MANAGED_SESSIONS, 'shared-name.jsonl'),
        join(UBUNTU_SYSTEM_SESSIONS, 'unique-ubuntu.jsonl'),
        join(DEBIAN_MANAGED_SESSIONS, 'shared-name.jsonl'),
        join(DEBIAN_SYSTEM_SESSIONS, 'unique-debian.jsonl')
      ].sort()
    )
  })
})
