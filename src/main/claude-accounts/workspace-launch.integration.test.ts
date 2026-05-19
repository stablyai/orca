// Why: end-to-end coverage that ClaudeAccountService.prepareForWorktreeLaunch
// routes through the workspace resolver so per-worktree overrides materialize
// the correct provider env at PTY launch time. Keeps focus on the routing path
// rather than full PTY spawn — the resolver wiring is the load-bearing piece. (P2)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { ClaudeManagedAccount, GlobalSettings } from '../../shared/types'

const KEYCHAIN_STORE = new Map<string, string>()
const testState = {
  userDataDir: '',
  fakeHomeDir: ''
}

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

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => 'claude'
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async (id: string) => {
    KEYCHAIN_STORE.delete(id)
  }),
  readActiveClaudeKeychainCredentials: vi.fn(async () => null),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async () => null),
  readManagedClaudeKeychainCredentials: vi.fn(
    async (id: string) => KEYCHAIN_STORE.get(id) ?? null
  ),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeActiveClaudeKeychainCredentialsForRuntime: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async (id: string, value: string) => {
    KEYCHAIN_STORE.set(id, value)
  })
}))

function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings(testState.fakeHomeDir),
    ...overrides
  }
}

function createStore(settings: GlobalSettings) {
  let current = settings
  return {
    getSettings: vi.fn(() => current),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      current = {
        ...current,
        ...updates,
        notifications: {
          ...current.notifications,
          ...updates.notifications
        }
      }
      return current
    })
  }
}

function createApiKeyAccount(
  id: string,
  managedAuthPath: string,
  overrides: Partial<ClaudeManagedAccount> = {}
): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath,
    authMethod: 'anthropic-api-key',
    credentials: { authMethod: 'anthropic-api-key' },
    modelMapping: {},
    fallbackAccountIds: [],
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function createApiKeyManagedAuthDir(rootDir: string, accountId: string): string {
  // Why: non-OAuth providers still get an owned managed-auth dir (marker
  // file). The handler stores the secret only in Keychain — no credentials.json.
  const managedAuthPath = join(rootDir, 'claude-accounts', accountId, 'auth')
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, 'utf-8')
  return managedAuthPath
}

beforeEach(() => {
  KEYCHAIN_STORE.clear()
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-claude-workspace-launch-'))
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-home-launch-'))
  mkdirSync(join(testState.fakeHomeDir, '.claude'), { recursive: true })
})

afterEach(() => {
  rmSync(testState.userDataDir, { recursive: true, force: true })
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
})

describe('ClaudeAccountService.prepareForWorktreeLaunch — workspace resolver routing (P2)', () => {
  it('routes the launch env to the per-worktree override account', async () => {
    const globalAuthPath = createApiKeyManagedAuthDir(testState.userDataDir, 'global-A')
    const wsBAuthPath = createApiKeyManagedAuthDir(testState.userDataDir, 'ws-B')
    KEYCHAIN_STORE.set('global-A', 'sk-ant-global')
    KEYCHAIN_STORE.set('ws-B', 'sk-ant-worktree-B')

    const settings = createSettings({
      activeClaudeManagedAccountId: 'global-A',
      claudeAccountIdByWorkspace: { 'r::/wt1': 'ws-B' },
      claudeManagedAccounts: [
        createApiKeyAccount('global-A', globalAuthPath),
        createApiKeyAccount('ws-B', wsBAuthPath)
      ]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { ClaudeAccountService } = await import('./service')
    const runtimeAuth = new ClaudeRuntimeAuthService(store as never)
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const service = new ClaudeAccountService(store as never, rateLimits as never, runtimeAuth)

    const preparation = await service.prepareForWorktreeLaunch('r::/wt1')

    // Override account (ws-B) materializes — not the global default (global-A).
    expect(preparation.provenance).toBe('managed:ws-B')
    expect(preparation.materialization?.envPatch).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-worktree-B'
    })
    // Global active id remains untouched — overrides are launch-time only.
    expect(store.getSettings().activeClaudeManagedAccountId).toBe('global-A')
  })

  it('falls back to the global default when the worktree has no override', async () => {
    const globalAuthPath = createApiKeyManagedAuthDir(testState.userDataDir, 'global-A')
    KEYCHAIN_STORE.set('global-A', 'sk-ant-global-fallback')

    const settings = createSettings({
      activeClaudeManagedAccountId: 'global-A',
      claudeAccountIdByWorkspace: {},
      claudeManagedAccounts: [createApiKeyAccount('global-A', globalAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { ClaudeAccountService } = await import('./service')
    const runtimeAuth = new ClaudeRuntimeAuthService(store as never)
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const service = new ClaudeAccountService(store as never, rateLimits as never, runtimeAuth)

    const preparation = await service.prepareForWorktreeLaunch('r::/unmapped-wt')

    expect(preparation.provenance).toBe('managed:global-A')
    expect(preparation.materialization?.envPatch).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-global-fallback'
    })
  })

  it('ignores stale override pointing at a deleted account, falls through to global', async () => {
    const globalAuthPath = createApiKeyManagedAuthDir(testState.userDataDir, 'global-A')
    KEYCHAIN_STORE.set('global-A', 'sk-ant-global-only')

    const settings = createSettings({
      activeClaudeManagedAccountId: 'global-A',
      // Why: override references an account id that was since removed. The
      // resolver must not return a phantom id — it falls through to the global
      // default so launches still succeed.
      claudeAccountIdByWorkspace: { 'r::/wt1': 'ws-deleted' },
      claudeManagedAccounts: [createApiKeyAccount('global-A', globalAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { ClaudeAccountService } = await import('./service')
    const runtimeAuth = new ClaudeRuntimeAuthService(store as never)
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const service = new ClaudeAccountService(store as never, rateLimits as never, runtimeAuth)

    const preparation = await service.prepareForWorktreeLaunch('r::/wt1')

    expect(preparation.provenance).toBe('managed:global-A')
    expect(preparation.materialization?.envPatch).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-global-only'
    })
  })
})
