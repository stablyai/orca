import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import type * as CodexManagedTrustReconciliation from './codex-managed-trust-reconciliation'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Follow-up to STA-4823: two more reads on the Codex hook paths acted on
// "absent" when the real answer was "could not read". Both were found while
// reviewing #15417 and are not covered by it.
//
// The denial shape here is the MEASURED one: chmod 000 / icacls deny leave
// existsSync true and stat succeeding, and fail only the content read
// (EACCES -13 on macOS, EPERM -4048 on Windows). No mode fakes existsSync,
// because no platform does.

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
        `EACCES: permission denied, ${syscall} '${target}'`
      )
      error.code = 'EACCES'
      error.errno = -13
      error.syscall = syscall
      error.path = target
      throw error
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const guardRead = (fn: unknown, syscall: string): unknown => {
    const original = fn as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => {
      denials.check(args[0], syscall)
      return original(...args)
    }
    return Object.assign(wrapped, original)
  }
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: guardRead(actual.readFileSync, 'read'),
    // Why: existsSync and stat stay HEALTHY. That is the whole point — a
    // permission denial does not hide the file, it only refuses its contents.
    openSync: Object.assign((...args: unknown[]): unknown => {
      const flags = args[1]
      if (flags === undefined || (typeof flags === 'string' && flags.startsWith('r'))) {
        denials.check(args[0], 'open')
      }
      return (actual.openSync as (...a: unknown[]) => unknown)(...args)
    }, actual.openSync)
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

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  denials.reset()
  fakeHomeDir = realFs.mkdtempSync(join(tmpdir(), 'orca-hooksread-home-'))
  userDataDir = realFs.mkdtempSync(join(tmpdir(), 'orca-hooksread-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  realFs.mkdirSync(join(fakeHomeDir, '.codex'), { recursive: true })
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

describe('an unreadable legacy hooks.json must not clear managed trust or its ledger', () => {
  it('returns before the removal branch instead of discarding approvals', async () => {
    const legacyHooksPath = join(fakeHomeDir, '.codex', 'hooks.json')
    realFs.writeFileSync(legacyHooksPath, JSON.stringify({ hooks: { Stop: [] } }), 'utf-8')

    const removeSpy = vi.fn()
    vi.resetModules()
    vi.doMock('./codex-managed-trust-reconciliation', async (importOriginal) => {
      const actual = await importOriginal<typeof CodexManagedTrustReconciliation>()
      return { ...actual, removeCodexManagedHookTrustEntries: removeSpy }
    })
    try {
      // The removal only fires when a real-home grant is on record — without
      // this the branch is inert and the test proves nothing either way.
      const ledger = await import('./codex-trust-grant-ledger')
      ledger.writeCodexTrustGrantLedgerHome(
        join(fakeHomeDir, '.codex'),
        { entries: { 'seed:1': { trustedHash: 'sha256:seed' } } } as never,
        ledger.getCodexTrustGrantLedgerPath()
      )

      const hookService = await import('./hook-service')
      denials.deny(legacyHooksPath)

      hookService._internals.cleanupLegacySystemManagedHooks()

      // `readHooksJsonWithRaw` catches the denial and reports {raw:null,
      // config:null} — "could not read". Before the fix that fell into the same
      // branch as "no hooks configured", which removes the managed trust
      // entries AND their grant-ledger record. A read that failed is not
      // permission to discard approvals the user already gave.
      expect(removeSpy).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('./codex-managed-trust-reconciliation')
      vi.resetModules()
    }
  })
})
