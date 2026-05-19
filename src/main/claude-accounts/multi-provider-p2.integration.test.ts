// Why: P2 end-to-end coverage — exercises the full add-account → materialize
// flow for Azure Foundry (both API-key and Entra ID paths) and the workspace
// override resolver at PTY launch time. The autoplan-locked invariant is that
// Foundry uses its own env namespace (CLAUDE_CODE_USE_FOUNDRY,
// ANTHROPIC_FOUNDRY_*) and never leaks ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
// Also covers the legacy no-arg prepareForClaudeLaunch back-compat. (P2 T22)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'
import type { ClaudeAccountService } from './service'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'

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
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
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

// Why: Entra ID path shells out to `az`; mock at the CLI boundary so the test
// stays deterministic and does not require Azure CLI on the dev machine.
vi.mock('./providers/azure-cli', () => ({
  detectAzureEntraIdSignIn: vi.fn(async () => ({
    ok: true,
    account: { user: 'a', tenantId: 't' }
  })),
  getEntraAccessTokenForCognitiveServices: vi.fn(async () => ({ ok: true, token: 'jwt' }))
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

async function createFixture(): Promise<{
  service: ClaudeAccountService
  runtimeAuth: ClaudeRuntimeAuthService
  store: ReturnType<typeof createStore>
}> {
  const settings = createSettings()
  const store = createStore(settings)
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  const { ClaudeAccountService } = await import('./service')
  const runtimeAuth = new ClaudeRuntimeAuthService(store as never)
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
  }
  const service = new ClaudeAccountService(store as never, rateLimits as never, runtimeAuth)
  return { service, runtimeAuth, store }
}

beforeEach(() => {
  KEYCHAIN_STORE.clear()
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-claude-p2-integration-'))
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-p2-home-'))
  mkdirSync(join(testState.fakeHomeDir, '.claude'), { recursive: true })
})

afterEach(() => {
  rmSync(testState.userDataDir, { recursive: true, force: true })
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
})

describe('Multi-provider P2 — end-to-end integration', () => {
  it('add azure-foundry (API key) → launch env emits FOUNDRY namespace, no API_KEY/BASE_URL', async () => {
    const { service, runtimeAuth } = await createFixture()
    await service.addAccount({
      authMethod: 'azure-foundry',
      label: 'Foundry prod',
      secretFromUser: 'fkey',
      providerConfig: { resource: 'prod-res' }
    })

    const preparation = await runtimeAuth.prepareForClaudeLaunch()
    const env = preparation.materialization?.envPatch ?? {}

    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe('1')
    expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBe('prod-res')
    expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBe('fkey')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('add azure-foundry (Entra ID) → launch env omits API key', async () => {
    const { service, runtimeAuth } = await createFixture()
    await service.addAccount({
      authMethod: 'azure-foundry',
      label: 'Foundry dev',
      providerConfig: { resource: 'dev-res', useEntraId: true }
    })

    const preparation = await runtimeAuth.prepareForClaudeLaunch()
    const env = preparation.materialization?.envPatch ?? {}

    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe('1')
    expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBe('dev-res')
    expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined()
  })

  it('workspace override resolves to a different account at launch', async () => {
    const { service, store } = await createFixture()
    const r1 = await service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'global',
      secretFromUser: 'g-key'
    })
    // Why: getSnapshot() sorts by updatedAt DESC, so the newest account lands
    // at accounts[0]. With one account so far, accounts[0] is the global.
    const globalAccount = r1.accounts[0]
    const r2 = await service.addAccount({
      authMethod: 'azure-foundry',
      label: 'workspace',
      secretFromUser: 'w-key',
      providerConfig: { resource: 'r-x' }
    })
    // After the second add, accounts[0] is the freshly-added Foundry one.
    const wsAccount = r2.accounts[0]
    // Why: polymorphic addAccount auto-selects the new account; pin the global
    // pointer back to the api-key account so the override has something to beat.
    await service.selectAccount(globalAccount.id)
    await service.setWorkspaceOverride({ worktreeId: 'r::/wt1', accountId: wsAccount.id })

    const preparation = await service.prepareForWorktreeLaunch('r::/wt1')
    const env = preparation.materialization?.envPatch ?? {}

    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe('1')
    expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBe('r-x')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    // Global active id remains untouched — overrides are launch-time only.
    expect(store.getSettings().activeClaudeManagedAccountId).toBe(globalAccount.id)
  })

  it('clearing the override falls back to the global account at launch', async () => {
    const { service } = await createFixture()
    const r1 = await service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'global',
      secretFromUser: 'g-key'
    })
    const globalAccount = r1.accounts[0]
    const r2 = await service.addAccount({
      authMethod: 'azure-foundry',
      label: 'ws',
      secretFromUser: 'w',
      providerConfig: { resource: 'r-x' }
    })
    // accounts[0] is the freshly-added Foundry account (sorted by updatedAt DESC).
    await service.selectAccount(globalAccount.id)
    await service.setWorkspaceOverride({
      worktreeId: 'r::/wt1',
      accountId: r2.accounts[0].id
    })
    await service.clearWorkspaceOverride({ worktreeId: 'r::/wt1' })

    const preparation = await service.prepareForWorktreeLaunch('r::/wt1')
    const env = preparation.materialization?.envPatch ?? {}

    expect(env.ANTHROPIC_API_KEY).toBe('g-key')
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
  })

  it('legacy no-arg prepareForClaudeLaunch still returns the global account env', async () => {
    const { service, runtimeAuth } = await createFixture()
    const r = await service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'g',
      secretFromUser: 'g-key'
    })
    await service.selectAccount(r.accounts[0].id)

    const preparation = await runtimeAuth.prepareForClaudeLaunch()
    const env = preparation.materialization?.envPatch ?? {}

    expect(env.ANTHROPIC_API_KEY).toBe('g-key')
  })
})
