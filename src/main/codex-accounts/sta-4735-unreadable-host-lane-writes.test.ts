import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

// STA-4735: two host-lane reads still answered "absent" from a read that had
// only failed, and both answers authorised a write over live data.

const denials = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    reads: new Map<string, number>(),
    deny(path: string): void {
      state.paths.add(path)
    },
    release(path: string): void {
      state.paths.delete(path)
    },
    readsFor(path: string): number {
      return state.reads.get(path) ?? 0
    },
    reset(): void {
      state.paths.clear()
      state.reads.clear()
    },
    check(target: unknown, syscall: string): void {
      if (typeof target !== 'string' || !state.paths.has(target)) {
        return
      }
      state.reads.set(target, (state.reads.get(target) ?? 0) + 1)
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
    lstatSync: guard(actual.lstatSync, 'lstat'),
    statSync: guard(actual.statSync, 'stat'),
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

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

const realFs = await vi.importActual<typeof NodeFs>('node:fs')

type RuntimeAuthWriter = {
  writeRuntimeAuth(
    contents: string,
    owner: { owner: 'system-default' } | { owner: 'managed'; accountId: string },
    options?: { expectedContents: string | null }
  ): boolean
}

describe('STA-4735 an unreadable runtime auth.json must not be written over', () => {
  beforeEach(() => {
    denials.reset()
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    denials.reset()
    teardownRuntimeHomeTest()
  })

  async function createService(): Promise<RuntimeAuthWriter> {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    return new CodexRuntimeHomeService(store as never) as unknown as RuntimeAuthWriter
  }

  it('refuses the write instead of overwriting a token it could not read', async () => {
    const service = await createService()
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const ROTATED = createCodexAuthJson('user@example.com', 'acct-1', 'refresh-rotated-by-codex')
    const STALE = createCodexAuthJson('user@example.com', 'acct-1', 'refresh-stale-orca-copy')
    realFs.mkdirSync(join(runtimeAuthPath, '..'), { recursive: true })
    realFs.writeFileSync(runtimeAuthPath, ROTATED, 'utf-8')

    denials.deny(runtimeAuthPath)
    const wrote = service.writeRuntimeAuth(STALE, { owner: 'managed', accountId: 'account-1' })

    // The fault really was consumed by the code under test.
    expect(denials.readsFor(runtimeAuthPath)).toBeGreaterThan(0)
    // THE FIX. Before it, "could not read" counted as "differs" and the write
    // below replaced a freshly rotated refresh token with Orca's stale copy.
    expect(wrote).toBe(false)
    expect(realFs.readFileSync(runtimeAuthPath, 'utf-8')).toBe(ROTATED)
  })

  it('still writes once the file is readable again', async () => {
    const service = await createService()
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const NEXT = createCodexAuthJson('user@example.com', 'acct-1', 'refresh-2')
    realFs.mkdirSync(join(runtimeAuthPath, '..'), { recursive: true })
    realFs.writeFileSync(runtimeAuthPath, 'stale\n', 'utf-8')

    // Why: the anchor. A fix that simply stopped writing would pass the test
    // above and break every credential sync.
    const wrote = service.writeRuntimeAuth(NEXT, { owner: 'managed', accountId: 'account-1' })

    expect(wrote).toBe(true)
    expect(realFs.readFileSync(runtimeAuthPath, 'utf-8')).toBe(NEXT)
  })
})
