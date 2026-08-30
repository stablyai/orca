import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
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

const deniedReads = vi.hoisted(() => {
  const paths = new Set<string>()
  const counts = new Map<string, number>()
  return {
    deny(path: string): void {
      paths.add(path)
    },
    count(path: string): number {
      return counts.get(path) ?? 0
    },
    reset(): void {
      paths.clear()
      counts.clear()
    },
    check(target: unknown): void {
      if (typeof target !== 'string' || !paths.has(target)) {
        return
      }
      counts.set(target, (counts.get(target) ?? 0) + 1)
      const error: NodeJS.ErrnoException = new Error(`EACCES: permission denied, read '${target}'`)
      error.code = 'EACCES'
      error.syscall = 'read'
      error.path = target
      throw error
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    deniedReads.check(args[0])
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  const patched = { ...actual, readFileSync: Object.assign(readFileSync, actual.readFileSync) }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

const realFs = await vi.importActual<typeof NodeFs>('node:fs')
const API_KEY_AUTH = `${JSON.stringify({
  auth_mode: 'apikey',
  OPENAI_API_KEY: 'sk-live-runtime'
})}\n`
const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

describe('STA-4991 WSL auth projection failures', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    deniedReads.reset()
    setupRuntimeHomeTest()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    deniedReads.reset()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it.each(['runtime', 'managed', 'system'] as const)(
    'keeps live runtime auth when the %s auth read returns EACCES',
    async (deniedLane) => {
      const fixture = createFixture({
        selected: deniedLane !== 'system',
        systemAuth: deniedLane === 'system'
      })
      realFs.mkdirSync(fixture.runtimeHome, { recursive: true })
      realFs.writeFileSync(fixture.runtimeAuthPath, API_KEY_AUTH, 'utf-8')
      const deniedPath =
        deniedLane === 'runtime'
          ? fixture.runtimeAuthPath
          : deniedLane === 'managed'
            ? fixture.managedAuthPath
            : fixture.systemAuthPath
      deniedReads.deny(deniedPath)

      const service = await createService(fixture.store)
      expect(service.prepareForCodexLaunch(target)).toBe(fixture.runtimeHome)

      expect(deniedReads.count(deniedPath)).toBeGreaterThan(0)
      expect(realFs.readFileSync(fixture.runtimeAuthPath, 'utf-8')).toBe(API_KEY_AUTH)
      expect(fixture.store.updateSettings).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['incomplete', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'partial' } })],
    ['malformed', '{']
  ])('keeps selection when managed auth is readable but %s', async (_label, contents) => {
    const fixture = createFixture({ selected: true })
    realFs.mkdirSync(fixture.runtimeHome, { recursive: true })
    realFs.writeFileSync(fixture.runtimeAuthPath, API_KEY_AUTH, 'utf-8')
    realFs.writeFileSync(fixture.managedAuthPath, contents, 'utf-8')

    const service = await createService(fixture.store)
    expect(service.prepareForCodexLaunch(target)).toBe(fixture.runtimeHome)

    expect(realFs.readFileSync(fixture.runtimeAuthPath, 'utf-8')).toBe(API_KEY_AUTH)
    expect(fixture.store.updateSettings).not.toHaveBeenCalled()
  })

  it.each(['missing', 'no-credential'] as const)(
    'deselects a managed source that is definitively %s',
    async (sourceState) => {
      const fixture = createFixture({ selected: true })
      realFs.mkdirSync(fixture.runtimeHome, { recursive: true })
      realFs.writeFileSync(fixture.runtimeAuthPath, API_KEY_AUTH, 'utf-8')
      if (sourceState === 'missing') {
        realFs.rmSync(fixture.managedAuthPath)
      } else {
        realFs.writeFileSync(fixture.managedAuthPath, '{}', 'utf-8')
      }

      const service = await createService(fixture.store)
      expect(service.prepareForCodexLaunch(target)).toBe(fixture.runtimeHome)

      expect(realFs.readFileSync(fixture.runtimeAuthPath, 'utf-8')).toBe(API_KEY_AUTH)
      expect(fixture.store.updateSettings).toHaveBeenCalledWith({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    }
  )

  it('projects restored bytes when the same missing managed account is reselected', async () => {
    const fixture = createFixture({ selected: true })
    const service = await createService(fixture.store)

    expect(service.prepareForCodexLaunch(target)).toBe(fixture.runtimeHome)
    realFs.writeFileSync(fixture.runtimeAuthPath, API_KEY_AUTH, 'utf-8')
    realFs.rmSync(fixture.managedAuthPath)

    expect(service.prepareForCodexLaunch(target)).toBe(fixture.runtimeHome)
    expect(realFs.readFileSync(fixture.runtimeAuthPath, 'utf-8')).toBe(API_KEY_AUTH)

    const restoredAuth = createCodexAuthJson(
      'managed@example.com',
      'acct-managed',
      'restored-refresh'
    )
    realFs.writeFileSync(fixture.managedAuthPath, restoredAuth, 'utf-8')
    fixture.store.updateSettings({
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
    })

    expect(service.prepareForCodexLaunch(target)).toBe(fixture.runtimeHome)
    expect(realFs.readFileSync(fixture.runtimeAuthPath, 'utf-8')).toBe(restoredAuth)
  })
})

function createFixture(args: { selected: boolean; systemAuth?: boolean }) {
  const wslHome = join(testState.userDataDir, 'wsl-home')
  vi.doMock('../wsl', () => ({
    getDefaultWslDistro: () => 'Ubuntu',
    getWslHome: () => wslHome
  }))
  const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed-refresh')
  const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
  const systemAuthPath = join(wslHome, '.codex', 'auth.json')
  if (args.systemAuth) {
    realFs.mkdirSync(join(systemAuthPath, '..'), { recursive: true })
    realFs.writeFileSync(
      systemAuthPath,
      createCodexAuthJson('system@example.com', 'acct-system', 'system-refresh'),
      'utf-8'
    )
  }
  const store = createStore(
    createSettings({
      codexManagedAccounts: [wslAccount(managedHomePath)],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: args.selected ? 'account-1' : null }
      }
    })
  )
  const runtimeHome = join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
  return {
    store,
    runtimeHome,
    runtimeAuthPath: join(runtimeHome, 'auth.json'),
    managedAuthPath: join(managedHomePath, 'auth.json'),
    systemAuthPath
  }
}

async function createService(store: ReturnType<typeof createStore>) {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  return new CodexRuntimeHomeService(store as never)
}

function wslAccount(managedHomePath: string): CodexManagedAccount {
  return {
    id: 'account-1',
    email: 'managed@example.com',
    managedHomePath,
    managedHomeRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
    providerAccountId: 'acct-managed',
    workspaceLabel: null,
    workspaceAccountId: 'acct-managed',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}
