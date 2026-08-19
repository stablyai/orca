/**
 * STA-4422 symptom 2: the status bar's "Sign in" action re-authenticates an
 * account while nothing is selected, and the pre-login capture restored that
 * empty selection — the browser said "Signed in to Codex" and the account was
 * still inactive. The activation intent is deliberately narrow: it may only fill
 * an empty lane, and the decision is made from the value captured *before* the
 * OAuth await because the runtime-home poll runs outside the mutation queue.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { GlobalSettings } from '../../shared/global-settings-types'
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

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

function createHostAccounts(): GlobalSettings['codexManagedAccounts'] {
  return ['account-1', 'account-2'].map((id, index) => ({
    id,
    email: `${id}@example.com`,
    managedHomePath: createManagedHome(
      testState.userDataDir,
      id,
      '',
      createCodexAuthJson(`${id}@example.com`, `provider-${id}`, `refresh-${id}`)
    ),
    providerAccountId: `provider-${id}`,
    workspaceLabel: null,
    workspaceAccountId: `provider-${id}`,
    createdAt: index + 1,
    updatedAt: index + 1,
    lastAuthenticatedAt: index + 1
  }))
}

/** Real `codex login` stand-in: writes fresh credentials, optionally racing the store. */
function createLoginSpawn(onLogin?: () => void) {
  return vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    onLogin?.()
    writeFileSync(
      join(options.env.CODEX_HOME!, 'auth.json'),
      createCodexAuthJson('reauthenticated@example.com', 'provider-new', 'refresh-new'),
      'utf-8'
    )
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
}

describe('CodexAccountService reauthenticate activation intent', () => {
  registerCodexAccountsTestHomes()

  it('activates the re-authed account when the intent is set and nothing was selected', async () => {
    vi.resetModules()
    const spawnMock = createLoginSpawn()
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    const settings = createSettings({
      codexManagedAccounts: createHostAccounts(),
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    const rateLimits = createRateLimits()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.reauthenticateAccount('account-2', {
      activateIfSelectionWasEmpty: true
    })

    // Healthy anchor: the login really ran and its identity landed.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(result.accounts.find((account) => account.id === 'account-2')).toMatchObject({
      email: 'reauthenticated@example.com',
      providerAccountId: 'provider-new'
    })
    expect(result.activeAccountId).toBe('account-2')
    expect(result.activeAccountIdsByRuntime).toEqual({ host: 'account-2', wsl: {} })
    expect(store.getSettings()).toMatchObject({
      activeCodexManagedAccountId: 'account-2',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-2', wsl: {} }
    })
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
  })

  it('keeps the previously selected account even when the selection is cleared during OAuth', async () => {
    vi.resetModules()
    // Why: the runtime-home poll runs outside the mutation queue, so it can null
    // the lane while the login promise is pending. A post-login read of the
    // selection would see that null and hand the lane to the wrong account.
    const spawnMock = createLoginSpawn(() => {
      const current = store.getSettings()
      store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...current.activeCodexManagedAccountIdsByRuntime!,
          host: null
        }
      })
    })
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    const settings = createSettings({
      codexManagedAccounts: createHostAccounts(),
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    const rateLimits = createRateLimits()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.reauthenticateAccount('account-2', {
      activateIfSelectionWasEmpty: true
    })

    // Healthy anchor: the concurrent clear really landed before the settings write.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(result.activeAccountId).toBe('account-1')
    expect(result.activeAccountIdsByRuntime).toEqual({ host: 'account-1', wsl: {} })
    expect(store.getSettings()).toMatchObject({
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
  })

  it('leaves the selection empty without the intent, as the settings pane expects', async () => {
    vi.resetModules()
    const spawnMock = createLoginSpawn()
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    const settings = createSettings({
      codexManagedAccounts: createHostAccounts(),
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    const rateLimits = createRateLimits()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.reauthenticateAccount('account-2')

    // Healthy anchor: the same login ran; only the selection outcome differs.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(result.accounts.find((account) => account.id === 'account-2')).toMatchObject({
      email: 'reauthenticated@example.com'
    })
    expect(result.activeAccountId).toBeNull()
    expect(result.activeAccountIdsByRuntime).toEqual({ host: null, wsl: {} })
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
  })
})
