import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

const { fsMockState } = vi.hoisted(() => ({
  fsMockState: { failSymlink: false }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (fsMockState.failSymlink) {
        throw new Error('symlink disabled for test')
      }
      return actual.symlinkSync(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { syncSystemCodexResourcesIntoManagedHome } from './codex-home-paths'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemCodexHomePath(): string {
  return join(fakeHomeDir, '.codex')
}

function getRuntimeCodexHomePath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function normalizeLinkTarget(linkTarget: string): string {
  return process.platform === 'win32'
    ? linkTarget.replace(/^\\\\\?\\/, '').toLowerCase()
    : linkTarget
}

function expectSymbolicLinkTargetIfLinked(targetPath: string, sourcePath: string): void {
  if (!lstatSync(targetPath).isSymbolicLink()) {
    return
  }
  expect(normalizeLinkTarget(readlinkSync(targetPath))).toBe(normalizeLinkTarget(sourcePath))
}

function mockElectronAppPaths(): void {
  vi.doMock('electron', () => ({
    app: {
      getPath: getPathMock
    }
  }))
}

beforeEach(() => {
  mockElectronAppPaths()
  fsMockState.failSymlink = false
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-resource-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-resource-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('syncSystemCodexResourcesIntoManagedHome', () => {
  it('uses ORCA_USER_DATA_PATH when Electron cannot be required', async () => {
    vi.resetModules()
    vi.doMock('electron', () => {
      throw new Error('electron unavailable in packaged CLI')
    })
    const previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    try {
      const { getOrcaManagedCodexHomePath: getCliSafeManagedPath } =
        await import('./codex-home-paths')

      expect(getCliSafeManagedPath()).toBe(join(userDataDir, 'codex-runtime-home', 'home'))
    } finally {
      if (previousUserDataPath === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = previousUserDataPath
      }
      mockElectronAppPaths()
      vi.resetModules()
    }
  })

  it('mirrors only user resource entries into the managed runtime home', () => {
    mkdirSync(join(getSystemCodexHomePath(), 'skills', 'review'), { recursive: true })
    mkdirSync(join(getSystemCodexHomePath(), 'plugins'), { recursive: true })
    mkdirSync(join(getSystemCodexHomePath(), 'sessions'), { recursive: true })
    writeFileSync(join(getSystemCodexHomePath(), 'skills', 'review', 'SKILL.md'), 'skill\n')
    writeFileSync(join(getSystemCodexHomePath(), 'plugins', 'plugin.json'), '{}\n')
    writeFileSync(join(getSystemCodexHomePath(), 'auth.json'), '{"account":"system"}\n')
    writeFileSync(join(getSystemCodexHomePath(), 'hooks.json'), '{"hooks":{}}\n')
    writeFileSync(join(getSystemCodexHomePath(), 'history.jsonl'), '{}\n')

    syncSystemCodexResourcesIntoManagedHome()

    const runtimeSkillsPath = join(getRuntimeCodexHomePath(), 'skills')
    const runtimePluginsPath = join(getRuntimeCodexHomePath(), 'plugins')
    expect(readFileSync(join(runtimeSkillsPath, 'review', 'SKILL.md'), 'utf-8')).toBe('skill\n')
    expect(readFileSync(join(runtimePluginsPath, 'plugin.json'), 'utf-8')).toBe('{}\n')
    expectSymbolicLinkTargetIfLinked(runtimeSkillsPath, join(getSystemCodexHomePath(), 'skills'))
    expect(existsSync(join(getRuntimeCodexHomePath(), 'sessions'))).toBe(false)
    expect(existsSync(join(getRuntimeCodexHomePath(), 'auth.json'))).toBe(false)
    expect(existsSync(join(getRuntimeCodexHomePath(), 'hooks.json'))).toBe(false)
    expect(existsSync(join(getRuntimeCodexHomePath(), 'history.jsonl'))).toBe(false)
  })

  it('does not replace an existing runtime-owned resource entry', () => {
    mkdirSync(join(getSystemCodexHomePath(), 'skills'), { recursive: true })
    mkdirSync(join(getRuntimeCodexHomePath(), 'skills'), { recursive: true })
    writeFileSync(join(getSystemCodexHomePath(), 'skills', 'system.md'), 'system\n')
    writeFileSync(join(getRuntimeCodexHomePath(), 'skills', 'runtime.md'), 'runtime\n')

    syncSystemCodexResourcesIntoManagedHome()

    const runtimeSkillsPath = join(getRuntimeCodexHomePath(), 'skills')
    expect(lstatSync(runtimeSkillsPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(runtimeSkillsPath, 'runtime.md'), 'utf-8')).toBe('runtime\n')
    expect(existsSync(join(runtimeSkillsPath, 'system.md'))).toBe(false)
  })

  it('removes owned symlinks for deleted system resources without touching unrelated runtime links', () => {
    const systemSkillsPath = join(getSystemCodexHomePath(), 'skills')
    const runtimeSkillsPath = join(getRuntimeCodexHomePath(), 'skills')
    const externalPluginsPath = join(userDataDir, 'external-plugins')
    const runtimePluginsPath = join(getRuntimeCodexHomePath(), 'plugins')
    mkdirSync(systemSkillsPath, { recursive: true })
    mkdirSync(externalPluginsPath, { recursive: true })
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(join(systemSkillsPath, 'system.md'), 'system\n')
    writeFileSync(join(externalPluginsPath, 'runtime.md'), 'runtime\n')
    symlinkSync(
      externalPluginsPath,
      runtimePluginsPath,
      process.platform === 'win32' ? 'junction' : undefined
    )

    syncSystemCodexResourcesIntoManagedHome()
    expect(lstatSync(runtimeSkillsPath).isSymbolicLink()).toBe(true)
    expectSymbolicLinkTargetIfLinked(runtimeSkillsPath, systemSkillsPath)

    rmSync(systemSkillsPath, { recursive: true, force: true })
    syncSystemCodexResourcesIntoManagedHome()

    expect(() => lstatSync(runtimeSkillsPath)).toThrow()
    expect(lstatSync(runtimePluginsPath).isSymbolicLink()).toBe(true)
    expectSymbolicLinkTargetIfLinked(runtimePluginsPath, externalPluginsPath)
    expect(readFileSync(join(runtimePluginsPath, 'runtime.md'), 'utf-8')).toBe('runtime\n')
  })

  it('refreshes owned fallback copies when symlinks are unavailable', () => {
    fsMockState.failSymlink = true
    const systemProfilePath = join(getSystemCodexHomePath(), 'profile-v2')
    const runtimeProfilePath = join(getRuntimeCodexHomePath(), 'profile-v2')
    writeFileSync(systemProfilePath, 'first\n', 'utf-8')

    syncSystemCodexResourcesIntoManagedHome()
    writeFileSync(systemProfilePath, 'second\n', 'utf-8')
    syncSystemCodexResourcesIntoManagedHome()

    expect(lstatSync(runtimeProfilePath).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeProfilePath, 'utf-8')).toBe('second\n')
  })
})
