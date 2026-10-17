import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { realpathSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
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
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const lstatFaults = vi.hoisted(() => {
  const held = new Set<string>()
  return {
    held,
    consume(target: unknown): void {
      if (typeof target !== 'string' || !held.has(target)) {
        return
      }
      const error: NodeJS.ErrnoException = new Error(`EPERM: operation not permitted, lstat`)
      error.code = 'EPERM'
      throw error
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper forwards the same arguments to the real lstatSync.
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

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

// Selection is A; the conversation was kept on B.
async function createService(): Promise<{
  service: CodexRuntimeHomeService
  store: ReturnType<typeof createStore>
  keptHome: string
}> {
  writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
  const selectedHome = createManagedAuth(
    testState.userDataDir,
    'account-a',
    createCodexAuthJson('a@example.com', 'acct-a', 'refresh-a')
  )
  const keptHome = createManagedAuth(
    testState.userDataDir,
    'account-b',
    createCodexAuthJson('b@example.com', 'acct-b', 'refresh-b')
  )
  const store = createStore(
    createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        createCodexAccountRecord('account-a', 'a@example.com', 'acct-a', selectedHome),
        createCodexAccountRecord('account-b', 'b@example.com', 'acct-b', keptHome)
      ],
      activeCodexManagedAccountId: 'account-a',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-a', wsl: {} }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements every Store method this service reads.
  return { service: new CodexRuntimeHomeService(store as never), store, keptHome }
}

describe('CodexRuntimeHomeService.resolveHostAccountCodexHomePathForKeptResume', () => {
  beforeEach(() => {
    lstatFaults.held.clear()
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    lstatFaults.held.clear()
    teardownRuntimeHomeTest()
  })

  it("resolves the kept account's own home, not the selection's", async () => {
    const { service, keptHome } = await createService()
    expect(service.resolveHostAccountCodexHomePathForKeptResume('account-b')).toBe(keptHome)
  })

  it('reports an unreadable kept home as temporarily unavailable and changes nothing', async () => {
    const { service, store, keptHome } = await createService()
    const { ManagedCodexHomeTemporarilyUnavailableError } =
      await import('./host-codex-managed-home-ownership')
    lstatFaults.held.add(join(realpathSync(keptHome), '.orca-managed-home'))

    expect(() => service.resolveHostAccountCodexHomePathForKeptResume('account-b')).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('refuses an untrusted kept home without clearing any selection', async () => {
    const { service, store, keptHome } = await createService()
    writeFileSync(join(keptHome, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    let thrown: unknown
    try {
      service.resolveHostAccountCodexHomePathForKeptResume('account-b')
    } catch (error) {
      thrown = error
    }
    expect(isAgentSessionPreSpawnError(thrown)).toBe(true)
    expect(String(thrown)).toContain('b@example.com')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-a')
  })

  it('never clears the selection, even when the kept account is the selected one', async () => {
    const { service, store } = await createService()
    const selectedHome = store.getSettings().codexManagedAccounts[0]!.managedHomePath
    writeFileSync(join(selectedHome, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    expect(() => service.resolveHostAccountCodexHomePathForKeptResume('account-a')).toThrow(
      /a@example\.com/
    )
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-a')
  })

  it('refuses an account that is no longer saved', async () => {
    const { service } = await createService()
    expect(() => service.resolveHostAccountCodexHomePathForKeptResume('account-gone')).toThrow(
      /no longer saved/
    )
  })
})
