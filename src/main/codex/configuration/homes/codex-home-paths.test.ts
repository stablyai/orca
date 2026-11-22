import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { dirname, join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

const { fsMockState } = vi.hoisted(() => ({
  fsMockState: {
    copyCount: 0,
    failSymlink: false,
    trackedReadCount: 0,
    trackedReadPath: null as string | null
  }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      fsMockState.copyCount += 1
      return actual.cpSync(...args)
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === fsMockState.trackedReadPath) {
        fsMockState.trackedReadCount += 1
      }
      return actual.readFileSync(...args)
    },
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

import {
  syncCodexGlobalInstructionsIntoManagedHome,
  syncSystemCodexResourcesIntoManagedHome
} from './codex-home-paths'

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
  fsMockState.copyCount = 0
  fsMockState.failSymlink = false
  fsMockState.trackedReadCount = 0
  fsMockState.trackedReadPath = null
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

  it('imports global rules beside account approvals and drops deleted ones (#24431)', () => {
    const systemRulesPath = join(getSystemCodexHomePath(), 'rules')
    const perAccountRulesPath = join(userDataDir, 'codex-accounts', 'account-1', 'home', 'rules')
    mkdirSync(systemRulesPath, { recursive: true })
    mkdirSync(perAccountRulesPath, { recursive: true })
    writeFileSync(join(systemRulesPath, 'default.rules'), 'global\n')
    writeFileSync(join(perAccountRulesPath, 'default.rules'), 'account approval\n')

    syncSystemCodexResourcesIntoManagedHome(dirname(perAccountRulesPath))

    // Codex loads sorted paths and later network/host_executable rules win, so account files must sort last.
    expect(readdirSync(perAccountRulesPath).sort()).toEqual([
      '_orca-global-default.rules',
      'default.rules'
    ])
    expect(readFileSync(join(perAccountRulesPath, 'default.rules'), 'utf-8')).toBe(
      'account approval\n'
    )
    expect(readFileSync(join(perAccountRulesPath, '_orca-global-default.rules'), 'utf-8')).toBe(
      'global\n'
    )

    rmSync(join(systemRulesPath, 'default.rules'))
    syncSystemCodexResourcesIntoManagedHome(dirname(perAccountRulesPath))

    expect(existsSync(join(perAccountRulesPath, '_orca-global-default.rules'))).toBe(false)
    expect(readFileSync(join(perAccountRulesPath, 'default.rules'), 'utf-8')).toBe(
      'account approval\n'
    )
  })

  it('never writes rule copies through a managed rules link into ~/.codex', () => {
    const systemRulesPath = join(getSystemCodexHomePath(), 'rules')
    mkdirSync(systemRulesPath, { recursive: true })
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(join(systemRulesPath, 'default.rules'), 'global\n')
    symlinkSync(
      systemRulesPath,
      join(getRuntimeCodexHomePath(), 'rules'),
      process.platform === 'win32' ? 'junction' : undefined
    )

    syncSystemCodexResourcesIntoManagedHome()

    expect(existsSync(join(systemRulesPath, '_orca-global-default.rules'))).toBe(false)
  })

  // Windows file symlinks require developer mode; the integration test still checks real copies.

  it('removes an unowned copy when recording copy ownership fails', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    writeFileSync(join(systemHomePath, 'AGENTS.md'), 'system\n')
    mkdirSync(managedHomePath, { recursive: true })
    writeFileSync(join(managedHomePath, '.orca-resource-copies'), 'blocks marker directory\n')

    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

    expect(existsSync(join(managedHomePath, 'AGENTS.md'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'preserves an unowned dangling runtime instruction symlink',
    () => {
      const systemHomePath = getSystemCodexHomePath()
      const managedHomePath = join(userDataDir, 'wsl-runtime-home')
      const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
      const missingTargetPath = join(userDataDir, 'missing-runtime-instructions.md')
      mkdirSync(managedHomePath, { recursive: true })
      writeFileSync(join(systemHomePath, 'AGENTS.md'), 'system\n')
      symlinkSync(missingTargetPath, runtimeAgentsPath)

      syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

      expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(true)
      expect(readlinkSync(runtimeAgentsPath)).toBe(missingTargetPath)
    }
  )
})
