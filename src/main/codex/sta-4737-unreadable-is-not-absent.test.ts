import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as CodexSettingsPromotion from './config-settings-promotion'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Model denials across all filesystem APIs so fallback reads cannot hide a missing guard.
const denials = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    readOnlyPaths: new Set<string>(),
    deny(path: string): void {
      state.paths.add(path)
    },
    reset(): void {
      state.paths.clear()
      state.readOnlyPaths.clear()
    },
    denyReads(path: string): void {
      state.readOnlyPaths.add(path)
    },
    has(target: unknown): boolean {
      return typeof target === 'string' && state.paths.has(target)
    },
    fail(target: string, syscall: string): never {
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, ${syscall} '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = syscall
      error.path = target
      throw error
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const guard = (fn: unknown, syscall: string): unknown => {
    const original = fn as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => {
      if (
        denials.has(args[0]) ||
        ((syscall === 'read' || syscall === 'copy') &&
          typeof args[0] === 'string' &&
          denials.readOnlyPaths.has(args[0]))
      ) {
        denials.fail(args[0] as string, syscall)
      }
      return original(...args)
    }
    return Object.assign(wrapped, original)
  }
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: guard(actual.readFileSync, 'read'),
    cpSync: guard(actual.cpSync, 'copy'),
    statSync: guard(actual.statSync, 'stat'),
    lstatSync: guard(actual.lstatSync, 'lstat'),
    openSync: guard(actual.openSync, 'open'),
    existsSync: Object.assign(
      (...args: unknown[]): boolean =>
        denials.has(args[0]) ? false : actual.existsSync(args[0] as string),
      actual.existsSync
    )
  }
  return { ...patched, default: patched }
})

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

const realFs = await vi.importActual<typeof NodeFs>('node:fs')

const { syncSystemConfigIntoLegacySharedCodexHome, syncSystemConfigIntoManagedCodexHome } =
  await import('./codex-config-mirror')
const { promoteCodexRuntimeSettingsToSystem, snapshotCodexRuntimeSettingsBaseline } =
  await import('./config-settings-promotion')
const { syncCodexGlobalInstructionsIntoManagedHome } = await import('./codex-home-paths')
const { markCopiedResource } = await import('./codex-managed-home-resource-copy-marker')

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

const systemHome = (): string => join(fakeHomeDir, '.codex')
const systemConfigPath = (): string => join(systemHome(), 'config.toml')
const runtimeHome = (): string => join(userDataDir, 'codex-runtime-home', 'home')
const runtimeConfigPath = (): string => join(runtimeHome(), 'config.toml')

beforeEach(() => {
  denials.reset()
  fakeHomeDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4737-home-'))
  userDataDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4737-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  realFs.mkdirSync(systemHome(), { recursive: true })
  realFs.mkdirSync(runtimeHome(), { recursive: true })
})

afterEach(() => {
  denials.reset()
  realFs.rmSync(fakeHomeDir, { recursive: true, force: true })
  realFs.rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('STA-4737 the config mirror must not overwrite a runtime config it could not read', () => {
  const SYSTEM_CONFIG = 'model = "system-model"\n'
  const RUNTIME_CONFIG = 'model = "user-picked"\n\n[mcp_servers.local]\ncommand = "run-me"\n'

  // Without a baseline, promotion skips the read, leaving the mirror responsible for refusal.
  it('leaves a denied runtime config exactly as it found it', () => {
    realFs.writeFileSync(systemConfigPath(), SYSTEM_CONFIG, 'utf-8')
    realFs.writeFileSync(runtimeConfigPath(), RUNTIME_CONFIG, 'utf-8')
    denials.deny(runtimeConfigPath())

    syncSystemConfigIntoManagedCodexHome()

    expect(realFs.readFileSync(runtimeConfigPath(), 'utf-8')).toBe(RUNTIME_CONFIG)
  })

  // Isolate the mirror guard from promotion, which can also refuse the denied read.
  it('refuses its own write when the runtime config is denied after promotion succeeded', async () => {
    realFs.writeFileSync(systemConfigPath(), SYSTEM_CONFIG, 'utf-8')
    realFs.writeFileSync(runtimeConfigPath(), RUNTIME_CONFIG, 'utf-8')

    vi.resetModules()
    vi.doMock('./config-settings-promotion', async (importOriginal) => {
      const actual = await importOriginal<typeof CodexSettingsPromotion>()
      return {
        ...actual,
        // Simulate a successful promotion read before the file becomes unreadable.
        promoteCodexRuntimeSettingsToSystem: () => ({
          conflicts: new Map(),
          runtimeValuesToPreserve: new Map()
        })
      }
    })
    try {
      const mirror = await import('./codex-config-mirror')
      denials.deny(runtimeConfigPath())
      mirror.syncSystemConfigIntoManagedCodexHome()
      expect(realFs.readFileSync(runtimeConfigPath(), 'utf-8')).toBe(RUNTIME_CONFIG)
    } finally {
      vi.doUnmock('./config-settings-promotion')
      vi.resetModules()
    }
  })

  it('still seeds a runtime config that is genuinely absent', () => {
    realFs.writeFileSync(systemConfigPath(), SYSTEM_CONFIG, 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(realFs.readFileSync(runtimeConfigPath(), 'utf-8')).toContain('model = "system-model"')
  })

  it('refuses the retained-pane mirror when its runtime config is denied', () => {
    realFs.writeFileSync(systemConfigPath(), SYSTEM_CONFIG, 'utf-8')
    realFs.writeFileSync(runtimeConfigPath(), RUNTIME_CONFIG, 'utf-8')
    denials.deny(runtimeConfigPath())

    expect(() =>
      syncSystemConfigIntoLegacySharedCodexHome({
        runtimeHomePath: runtimeHome(),
        systemHomePath: systemHome()
      })
    ).toThrow('EPERM')
    expect(realFs.readFileSync(runtimeConfigPath(), 'utf-8')).toBe(RUNTIME_CONFIG)
  })
})

describe('STA-4737 promotion must not rebuild a system config it could not read', () => {
  function seedPromotableRuntimeChange(): void {
    realFs.writeFileSync(systemConfigPath(), 'model = "old-model"\n', 'utf-8')
    realFs.writeFileSync(runtimeConfigPath(), 'model = "old-model"\n', 'utf-8')
    snapshotCodexRuntimeSettingsBaseline(runtimeHome())
    realFs.writeFileSync(runtimeConfigPath(), 'model = "new-model"\n', 'utf-8')
  }

  it('leaves a denied system config exactly as it found it', () => {
    seedPromotableRuntimeChange()
    const before = realFs.readFileSync(systemConfigPath(), 'utf-8')
    denials.deny(systemConfigPath())

    expect(
      promoteCodexRuntimeSettingsToSystem({
        runtimeHomePath: runtimeHome(),
        systemHomePath: systemHome()
      })
    ).toBeNull()

    expect(realFs.readFileSync(systemConfigPath(), 'utf-8')).toBe(before)
  })

  it('still promotes into a readable system config', () => {
    seedPromotableRuntimeChange()

    const plan = promoteCodexRuntimeSettingsToSystem({
      runtimeHomePath: runtimeHome(),
      systemHomePath: systemHome()
    })

    expect(plan).not.toBeNull()
    expect(realFs.readFileSync(systemConfigPath(), 'utf-8')).toContain('model = "new-model"')
  })
})

describe('STA-4737 the resource sync must not delete a mirror whose source it could not read', () => {
  const AGENTS_ENTRY = 'AGENTS.md'
  const MIRRORED = '# instructions Orca copied for the distro\n'

  function seedOwnedMirrorCopy(): { sourcePath: string; targetPath: string } {
    const sourcePath = join(systemHome(), AGENTS_ENTRY)
    const targetPath = join(runtimeHome(), AGENTS_ENTRY)
    realFs.writeFileSync(sourcePath, MIRRORED, 'utf-8')
    realFs.writeFileSync(targetPath, MIRRORED, 'utf-8')
    markCopiedResource(runtimeHome(), AGENTS_ENTRY, sourcePath)
    return { sourcePath, targetPath }
  }

  it('keeps the mirrored copy when the source is denied', () => {
    const { sourcePath, targetPath } = seedOwnedMirrorCopy()
    denials.deny(sourcePath)

    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath: systemHome(),
      managedHomePath: runtimeHome()
    })

    expect(realFs.existsSync(targetPath)).toBe(true)
    expect(realFs.readFileSync(targetPath, 'utf-8')).toBe(MIRRORED)
  })

  it('keeps the mirrored copy when the source becomes unreadable after stat', () => {
    const { sourcePath, targetPath } = seedOwnedMirrorCopy()
    // Windows sharing violations can allow stat while denying content reads.
    denials.denyReads(sourcePath)

    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath: systemHome(),
      managedHomePath: runtimeHome()
    })

    expect(realFs.readFileSync(targetPath, 'utf-8')).toBe(MIRRORED)
  })

  it('keeps an unreadable owned target instead of refreshing it', () => {
    const { sourcePath, targetPath } = seedOwnedMirrorCopy()
    realFs.writeFileSync(sourcePath, '# updated system instructions\n', 'utf-8')
    denials.deny(targetPath)

    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath: systemHome(),
      managedHomePath: runtimeHome()
    })

    expect(realFs.readFileSync(targetPath, 'utf-8')).toBe(MIRRORED)
  })

  it('still removes the mirrored copy when the source is genuinely gone', () => {
    const { sourcePath, targetPath } = seedOwnedMirrorCopy()
    realFs.rmSync(sourcePath)

    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath: systemHome(),
      managedHomePath: runtimeHome()
    })

    expect(realFs.existsSync(targetPath)).toBe(false)
  })
})
