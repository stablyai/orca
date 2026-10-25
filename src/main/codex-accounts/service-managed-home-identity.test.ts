import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  createCodexAuthJson,
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

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

const accountIAuth = createCodexAuthJson('i@example.com', 'provider-i', 'refresh-i')

function createAccountI() {
  return {
    id: 'account-i',
    email: 'i@example.com',
    managedHomePath: createManagedHome(testState.userDataDir, 'account-i', '', accountIAuth),
    providerAccountId: 'provider-i',
    workspaceLabel: null,
    workspaceAccountId: 'provider-i',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

async function createService(settings: ReturnType<typeof createSettings>) {
  const store = createStore(settings)
  const { CodexAccountService } = await import('./service')
  const service = new CodexAccountService(
    store as never,
    createRateLimits() as never,
    createRuntimeHome() as never
  )
  return { service, store }
}

describe('Codex managed home identity', () => {
  registerCodexAccountsTestHomes()

  it('keeps the existing login when a reauthentication is abandoned', async () => {
    vi.resetModules()
    // Mirrors `codex login`, which deletes the home's auth before its login server starts.
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        rmSync(join(options.env.CODEX_HOME!, 'auth.json'), { force: true })
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null,
          signalCode: null,
          kill: vi.fn(() => true)
        })
        return child
      }
    )
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const account = createAccountI()
    const { service, store } = await createService(
      createSettings({
        codexManagedAccounts: [account],
        activeCodexManagedAccountId: 'account-i',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-i', wsl: {} }
      })
    )

    const reauth = service.reauthenticateAccount('account-i')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    expect(service.cancelPendingLogin()).toBe(true)

    await expect(reauth).rejects.toThrow()
    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(accountIAuth)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-i')
  })

  it('relabels a managed account whose home now holds a different login', async () => {
    const account = createAccountI()
    writeFileSync(
      join(account.managedHomePath, 'auth.json'),
      createCodexAuthJson('c@example.com', 'provider-c', 'refresh-c'),
      'utf-8'
    )
    const { service } = await createService(createSettings({ codexManagedAccounts: [account] }))

    const listed = service.listAccounts().accounts.find((entry) => entry.id === 'account-i')

    expect(listed).toMatchObject({ email: 'c@example.com', providerAccountId: 'provider-c' })
    expect(listed?.updatedAt).toBeGreaterThan(account.updatedAt)
  })
})
