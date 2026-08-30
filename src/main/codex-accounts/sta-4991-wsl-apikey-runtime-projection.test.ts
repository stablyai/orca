import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

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

const API_KEY_AUTH = `${JSON.stringify({
  auth_mode: 'apikey',
  OPENAI_API_KEY: 'sk-test-wsl-apikey'
})}\n`

function wslRuntimeHomePath(wslHome: string): string {
  return join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
}

function wslAccount(args: {
  id: string
  email: string
  providerAccountId: string
  managedHomePath: string
}): CodexManagedAccount {
  return {
    id: args.id,
    email: args.email,
    managedHomePath: args.managedHomePath,
    managedHomeRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxHomePath: `/home/alice/.local/share/orca/codex-accounts/${args.id}/home`,
    providerAccountId: args.providerAccountId,
    workspaceLabel: null,
    workspaceAccountId: args.providerAccountId,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

describe('STA-4991 WSL API-key runtime projection', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    setupRuntimeHomeTest()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('keeps a live API-key runtime home and deselects the ChatGPT WSL account', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const chatgptAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-token')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', chatgptAuth)
    const runtimeHome = wslRuntimeHomePath(wslHome)
    mkdirSync(runtimeHome, { recursive: true })
    writeFileSync(join(runtimeHome, 'auth.json'), API_KEY_AUTH, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          wslAccount({
            id: 'account-1',
            email: 'wsl@example.com',
            providerAccountId: 'acct-wsl',
            managedHomePath
          })
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

    expect(service.prepareForCodexLaunch(target)).toBe(runtimeHome)
    expect(readFileSync(join(runtimeHome, 'auth.json'), 'utf-8')).toBe(API_KEY_AUTH)
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(chatgptAuth)
    expect(store.updateSettings).toHaveBeenCalledWith({
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    })

    expect(service.prepareForCodexLaunch(target)).toBe(runtimeHome)
    expect(readFileSync(join(runtimeHome, 'auth.json'), 'utf-8')).toBe(API_KEY_AUTH)
  })

  it('does not copy distro ChatGPT ~/.codex over a live API-key runtime home', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    mkdirSync(join(wslHome, '.codex'), { recursive: true })
    writeFileSync(join(wslHome, '.codex', 'auth.json'), systemAuth, 'utf-8')
    const runtimeHome = wslRuntimeHomePath(wslHome)
    mkdirSync(runtimeHome, { recursive: true })
    writeFileSync(join(runtimeHome, 'auth.json'), API_KEY_AUTH, 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(runtimeHome)
    expect(readFileSync(join(runtimeHome, 'auth.json'), 'utf-8')).toBe(API_KEY_AUTH)
    expect(readFileSync(join(wslHome, '.codex', 'auth.json'), 'utf-8')).toBe(systemAuth)
  })

  it('still projects when the user explicitly switches WSL ChatGPT accounts', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const firstAuth = createCodexAuthJson('first@example.com', 'acct-first', 'first-token')
    const secondAuth = createCodexAuthJson('second@example.com', 'acct-second', 'second-token')
    const firstHome = createManagedAuth(testState.userDataDir, 'account-1', firstAuth)
    const secondHome = createManagedAuth(testState.userDataDir, 'account-2', secondAuth)
    const runtimeHome = wslRuntimeHomePath(wslHome)
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          wslAccount({
            id: 'account-1',
            email: 'first@example.com',
            providerAccountId: 'acct-first',
            managedHomePath: firstHome
          }),
          wslAccount({
            id: 'account-2',
            email: 'second@example.com',
            providerAccountId: 'acct-second',
            managedHomePath: secondHome
          })
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

    expect(service.prepareForCodexLaunch(target)).toBe(runtimeHome)
    writeFileSync(join(runtimeHome, 'auth.json'), API_KEY_AUTH, 'utf-8')
    store.updateSettings({
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-2' } }
    })
    expect(service.prepareForCodexLaunch(target)).toBe(runtimeHome)
    expect(readFileSync(join(runtimeHome, 'auth.json'), 'utf-8')).toBe(secondAuth)
  })

  it('still seeds a proven-absent runtime home from the selected ChatGPT account', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const chatgptAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-token')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', chatgptAuth)
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          wslAccount({
            id: 'account-1',
            email: 'wsl@example.com',
            providerAccountId: 'acct-wsl',
            managedHomePath
          })
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const runtimeHome = wslRuntimeHomePath(wslHome)

    expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(runtimeHome)
    expect(readFileSync(join(runtimeHome, 'auth.json'), 'utf-8')).toBe(chatgptAuth)
  })
})
