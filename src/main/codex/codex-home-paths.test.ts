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

  it('mirrors resources into an explicit per-account home without mutating ~/.codex', () => {
    mkdirSync(join(getSystemCodexHomePath(), 'skills', 'review'), { recursive: true })
    writeFileSync(join(getSystemCodexHomePath(), 'skills', 'review', 'SKILL.md'), 'skill\n')
    const perAccountHome = join(userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(perAccountHome, { recursive: true })

    syncSystemCodexResourcesIntoManagedHome(perAccountHome)

    const perAccountSkillsPath = join(perAccountHome, 'skills')
    expect(readFileSync(join(perAccountSkillsPath, 'review', 'SKILL.md'), 'utf-8')).toBe('skill\n')
    expectSymbolicLinkTargetIfLinked(perAccountSkillsPath, join(getSystemCodexHomePath(), 'skills'))
    // The shared runtime mirror is untouched by an explicit per-account sync.
    expect(existsSync(join(getRuntimeCodexHomePath(), 'skills'))).toBe(false)
    // ~/.codex gains nothing — resources are only read from it, never written back.
    expect(existsSync(join(getSystemCodexHomePath(), 'codex-accounts'))).toBe(false)
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

  it('mirrors hooks directory into the managed runtime home (regression test for 127 exit)', () => {
    const systemHooksPath = join(getSystemCodexHomePath(), 'hooks')
    const runtimeHooksPath = join(getRuntimeCodexHomePath(), 'hooks')
    mkdirSync(systemHooksPath, { recursive: true })
    writeFileSync(join(systemHooksPath, 'observe-tool-use.sh'), '#!/bin/bash\necho ok\n')

    syncSystemCodexResourcesIntoManagedHome()

    expect(lstatSync(runtimeHooksPath).isSymbolicLink()).toBe(true)
    expectSymbolicLinkTargetIfLinked(runtimeHooksPath, systemHooksPath)
  })

  it('mirrors the global AGENTS.md into the managed runtime home so user instructions survive', () => {
    const systemAgentsPath = join(getSystemCodexHomePath(), 'AGENTS.md')
    const runtimeAgentsPath = join(getRuntimeCodexHomePath(), 'AGENTS.md')
    writeFileSync(systemAgentsPath, '# Global instructions\n')

    syncSystemCodexResourcesIntoManagedHome()

    expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('# Global instructions\n')
    expectSymbolicLinkTargetIfLinked(runtimeAgentsPath, systemAgentsPath)
  })

  it('skips unchanged global-instruction fallback copies when symlinks fail', () => {
    fsMockState.failSymlink = true
    const systemAgentsPath = join(getSystemCodexHomePath(), 'AGENTS.md')
    writeFileSync(systemAgentsPath, 'first\n')

    syncSystemCodexResourcesIntoManagedHome()
    expect(fsMockState.copyCount).toBe(1)
    syncSystemCodexResourcesIntoManagedHome()
    expect(fsMockState.copyCount).toBe(1)
    writeFileSync(systemAgentsPath, 'second\n')
    syncSystemCodexResourcesIntoManagedHome()

    expect(fsMockState.copyCount).toBe(2)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'AGENTS.md'), 'utf-8')).toBe('second\n')
  })

  it('mirrors only global instructions when explicit Codex homes are provided', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    mkdirSync(join(systemHomePath, 'skills'), { recursive: true })
    writeFileSync(join(systemHomePath, 'skills', 'system.md'), 'skill\n')
    writeFileSync(join(systemHomePath, 'AGENTS.md'), '# WSL instructions\n')

    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

    const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
    expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('# WSL instructions\n')
    // Why: WSL homes are \\wsl.localhost UNC paths, so a host-side symlink would
    // store a target the distro cannot resolve; global instructions must be a
    // real copy even when symlinks are available.
    expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(false)
    expect(existsSync(join(managedHomePath, 'skills'))).toBe(false)
  })

  // Why: creating file symlinks on Windows requires developer mode; the
  // runtime-home integration test still enforces real-copy behavior there.
  it.skipIf(process.platform === 'win32')(
    'materializes symlinked global instructions as a real file for WSL',
    () => {
      const systemHomePath = getSystemCodexHomePath()
      const managedHomePath = join(userDataDir, 'wsl-runtime-home')
      const instructionSourcePath = join(userDataDir, 'global-instructions.md')
      writeFileSync(instructionSourcePath, 'linked instructions\n')
      symlinkSync(instructionSourcePath, join(systemHomePath, 'AGENTS.md'))

      syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

      const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
      expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('linked instructions\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'replaces an existing system-instruction link despite a malformed marker directory',
    () => {
      const systemHomePath = getSystemCodexHomePath()
      const managedHomePath = join(userDataDir, 'wsl-runtime-home')
      const systemAgentsPath = join(systemHomePath, 'AGENTS.md')
      const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
      mkdirSync(managedHomePath, { recursive: true })
      writeFileSync(systemAgentsPath, 'system\n')
      symlinkSync(systemAgentsPath, runtimeAgentsPath)
      mkdirSync(join(managedHomePath, '.orca-resource-copies', 'AGENTS.md.json'), {
        recursive: true
      })

      syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

      expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('system\n')
    }
  )

  it('removes an unowned copy when recording copy ownership fails', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    writeFileSync(join(systemHomePath, 'AGENTS.md'), 'system\n')
    mkdirSync(managedHomePath, { recursive: true })
    writeFileSync(join(managedHomePath, '.orca-resource-copies'), 'blocks marker directory\n')

    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

    expect(existsSync(join(managedHomePath, 'AGENTS.md'))).toBe(false)
  })

  it('skips unchanged copies, then refreshes and removes owned global instructions', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    const systemAgentsPath = join(systemHomePath, 'AGENTS.md')
    const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
    writeFileSync(systemAgentsPath, 'first\n')

    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })
    expect(fsMockState.copyCount).toBe(1)
    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })
    expect(fsMockState.copyCount).toBe(1)
    writeFileSync(systemAgentsPath, 'second\n')
    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

    expect(fsMockState.copyCount).toBe(2)
    expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('second\n')
    rmSync(systemAgentsPath)
    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })
    expect(existsSync(runtimeAgentsPath)).toBe(false)
  })

  it('replaces an owned non-file instruction entry without reading it', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
    writeFileSync(join(systemHomePath, 'AGENTS.md'), 'system\n')
    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })
    rmSync(runtimeAgentsPath)
    mkdirSync(runtimeAgentsPath)
    fsMockState.trackedReadPath = runtimeAgentsPath

    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

    expect(fsMockState.trackedReadCount).toBe(0)
    expect(lstatSync(runtimeAgentsPath).isFile()).toBe(true)
    expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('system\n')
  })

  it('removes owned instructions instead of mirroring a non-file source', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    const systemAgentsPath = join(systemHomePath, 'AGENTS.md')
    const runtimeAgentsPath = join(managedHomePath, 'AGENTS.md')
    writeFileSync(systemAgentsPath, 'system\n')
    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })
    rmSync(systemAgentsPath)
    mkdirSync(systemAgentsPath)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })
    } finally {
      warn.mockRestore()
    }

    expect(existsSync(runtimeAgentsPath)).toBe(false)
  })

  it('preserves runtime-owned global instructions in an explicit managed home', () => {
    const systemHomePath = getSystemCodexHomePath()
    const managedHomePath = join(userDataDir, 'wsl-runtime-home')
    mkdirSync(managedHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'AGENTS.md'), 'system\n')
    writeFileSync(join(managedHomePath, 'AGENTS.md'), 'runtime\n')

    syncCodexGlobalInstructionsIntoManagedHome({ systemHomePath, managedHomePath })

    expect(readFileSync(join(managedHomePath, 'AGENTS.md'), 'utf-8')).toBe('runtime\n')
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
