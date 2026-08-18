import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { realpathSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

// STA-4422 P1g: automatic session resume picks the resumed pane's CODEX_HOME,
// i.e. its account. The read-only resolver collapses an unreadable home to
// `null`, which the ranking reads as "no account selected" — another account's
// readable alias then wins and the pane resumes under the wrong credentials.
// The resume boundary therefore resolves the selection eagerly through a
// refusing gate.

const lstatFaults = vi.hoisted(() => {
  const state = {
    /** paths that fail on EVERY read until released (models a held AV lock) */
    held: new Set<string>(),
    reads: new Map<string, number>(),
    hold(path: string): void {
      state.held.add(path)
    },
    release(path: string): void {
      state.held.delete(path)
    },
    heldReads(path: string): number {
      return state.reads.get(path) ?? 0
    },
    reset(): void {
      state.held.clear()
      state.reads.clear()
    },
    consume(target: unknown): void {
      if (typeof target !== 'string' || !state.held.has(target)) {
        return
      }
      state.reads.set(target, (state.reads.get(target) ?? 0) + 1)
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, lstat '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = 'lstat'
      error.path = target
      throw error
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const original = actual.lstatSync as (...args: unknown[]) => unknown
  const patched: Record<string, unknown> = {
    ...actual,
    lstatSync: Object.assign((...args: unknown[]): unknown => {
      lstatFaults.consume(args[0])
      return original(...args)
    }, original)
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

async function createServiceWithSelectedAccount(): Promise<{
  service: CodexRuntimeHomeService
  store: ReturnType<typeof createStore>
  managedHomePath: string
}> {
  writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
  const managedHomePath = createManagedAuth(
    testState.userDataDir,
    'account-a',
    createCodexAuthJson('a@example.com', 'acct-a', 'refresh-a')
  )
  createManagedAuth(
    testState.userDataDir,
    'account-b',
    createCodexAuthJson('b@example.com', 'acct-b', 'refresh-b')
  )
  const store = createStore(
    createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        createCodexAccountRecord('account-a', 'a@example.com', 'acct-a', managedHomePath),
        createCodexAccountRecord(
          'account-b',
          'b@example.com',
          'acct-b',
          join(testState.userDataDir, 'codex-accounts', 'account-b', 'home')
        )
      ],
      activeCodexManagedAccountId: 'account-a',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-a', wsl: {} }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  return { service: new CodexRuntimeHomeService(store as never), store, managedHomePath }
}

describe('CodexRuntimeHomeService.resolveSelectedHostAccountCodexHomePathForResume', () => {
  beforeEach(() => {
    lstatFaults.reset()
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    lstatFaults.reset()
    teardownRuntimeHomeTest()
  })

  it('refuses the resume while the selected account marker is locked, instead of reporting no selection', async () => {
    const { service, store, managedHomePath } = await createServiceWithSelectedAccount()
    const { ManagedCodexHomeTemporarilyUnavailableError } =
      await import('./host-codex-managed-home-ownership')

    // Anchor: a readable marker resolves the selected account's own home.
    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBe(managedHomePath)

    const markerPath = join(realpathSync(managedHomePath), '.orca-managed-home')
    lstatFaults.hold(markerPath)

    expect(() => service.resolveSelectedHostAccountCodexHomePathForResume()).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    // The injected fault really was consumed by the gate under test.
    expect(lstatFaults.heldReads(markerPath)).toBeGreaterThan(0)
    // Why this is the whole point: the read-only resolver still answers `null`,
    // which the resume ranking cannot distinguish from "system default", so the
    // resume boundary must not use it.
    expect(service.getSelectedHostAccountCodexHomePath()).toBeNull()
    // Refusing is not clearing.
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-a')
    expect(store.updateSettings).not.toHaveBeenCalled()

    // Recovery is automatic once the lock clears.
    lstatFaults.release(markerPath)
    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBe(managedHomePath)
  })

  it('reports no managed selection for a proven untrusted home rather than refusing', async () => {
    const { service, store, managedHomePath } = await createServiceWithSelectedAccount()

    // A successful observation that fails a trust check: the marker names
    // another account. The resume must proceed on the system/default ranking.
    writeFileSync(join(managedHomePath, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBeNull()
    expect(store.updateSettings).toHaveBeenCalledOnce()
  })
})
