import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
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

const lstatFaults = vi.hoisted(() => {
  const state = {
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
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
      realHomeRoutable: true,
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

    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBe(managedHomePath)

    const markerPath = join(realpathSync(managedHomePath), '.orca-managed-home')
    lstatFaults.hold(markerPath)

    expect(() => service.resolveSelectedHostAccountCodexHomePathForResume()).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )

    expect(lstatFaults.heldReads(markerPath)).toBeGreaterThan(0)
    // Discovery's null fallback cannot safely rank accounts for resume.
    expect(service.getSelectedHostAccountCodexHomePath()).toBeNull()

    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-a')
    expect(store.updateSettings).not.toHaveBeenCalled()

    lstatFaults.release(markerPath)
    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBe(managedHomePath)
  })

  it('reports no managed selection for a proven untrusted home rather than refusing', async () => {
    const { service, store, managedHomePath } = await createServiceWithSelectedAccount()

    writeFileSync(join(managedHomePath, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBeNull()
    expect(store.updateSettings).toHaveBeenCalledOnce()
  })
})
