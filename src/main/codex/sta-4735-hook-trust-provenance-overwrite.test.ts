import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STA-4735: the hook-trust provenance file is the only record of which
// config.toml trust entries Orca wrote versus which the user approved inside
// Codex. An unreadable one was rebuilt from the current config on the same
// pass, stamping the user's approval as Orca-written — after which promotion
// skips it forever.

const denials = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    deny(path: string): void {
      state.paths.add(path)
    },
    reset(): void {
      state.paths.clear()
    },
    check(target: unknown, syscall: string): void {
      if (typeof target !== 'string' || !state.paths.has(target)) {
        return
      }
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
      denials.check(args[0], syscall)
      return original(...args)
    }
    return Object.assign(wrapped, original)
  }
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: guard(actual.readFileSync, 'read'),
    existsSync: Object.assign(
      (...args: unknown[]): boolean =>
        typeof args[0] === 'string' && denials.paths.has(args[0])
          ? false
          : actual.existsSync(args[0] as string),
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
const { snapshotCodexRuntimeHookTrustProvenance } = await import('./hook-trust-promotion')

const PROVENANCE_ENTRY = 'orca-hooks:stop:0:0'
let fakeHomeDir: string
let userDataDir: string
let runtimeHomePath: string

const provenancePath = (): string => join(runtimeHomePath, '.orca-hook-trust-provenance.json')

function seedRecordedProvenance(): string {
  const contents = `${JSON.stringify(
    { version: 1, entries: { [PROVENANCE_ENTRY]: { trustedHash: 'sha256:orca', enabled: true } } },
    null,
    2
  )}\n`
  realFs.writeFileSync(provenancePath(), contents, 'utf-8')
  return contents
}

beforeEach(() => {
  denials.reset()
  fakeHomeDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4735-home-'))
  userDataDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4735-data-'))
  runtimeHomePath = join(userDataDir, 'codex-runtime-home', 'home')
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  realFs.mkdirSync(runtimeHomePath, { recursive: true })
  realFs.mkdirSync(join(fakeHomeDir, '.codex'), { recursive: true })
  realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "m"\n', 'utf-8')
})

afterEach(() => {
  denials.reset()
  realFs.rmSync(fakeHomeDir, { recursive: true, force: true })
  realFs.rmSync(userDataDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('STA-4735 snapshotCodexRuntimeHookTrustProvenance', () => {
  it('leaves a provenance record it could not read exactly as it found it', () => {
    const recorded = seedRecordedProvenance()
    denials.deny(provenancePath())

    snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)

    // Before the fix this rewrote the file from the current config.toml, which
    // holds no record of what Orca wrote — so a user approval made since the
    // last pass was permanently reclassified as Orca's own write.
    expect(realFs.readFileSync(provenancePath(), 'utf-8')).toBe(recorded)
  })

  it('still records a provenance file that does not exist yet', () => {
    // Why: writing the first snapshot is this function's whole job. A fix that
    // refused whenever the read failed would never seed one.
    snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)

    expect(realFs.existsSync(provenancePath())).toBe(true)
    expect(JSON.parse(realFs.readFileSync(provenancePath(), 'utf-8'))).toMatchObject({ version: 1 })
  })

  it('still replaces a provenance file that is present but malformed', () => {
    // Why: a corrupt record carries no information, and resetting it IS the
    // intent. Only the unreadable case may be preserved — conflating the two
    // would wedge a user on a broken file forever.
    realFs.writeFileSync(provenancePath(), '{ not json', 'utf-8')

    snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)

    expect(JSON.parse(realFs.readFileSync(provenancePath(), 'utf-8'))).toMatchObject({ version: 1 })
  })
})
