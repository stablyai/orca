// Why: end-to-end coverage that the full add-account → materialize-active flow
// emits the right env keys for each P1 provider, and that switching providers
// strips the previous provider's keys (autoplan E1 allowlist invariant).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount, GlobalSettings } from '../../shared/types'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-claude-multi-provider-test'
  }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => 'claude'
}))

// Mock keychain at the boundary so the test runs deterministic without OS Keychain.
const KEYCHAIN_STORE = new Map<string, string>()

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
  writeManagedClaudeKeychainCredentials: vi.fn(async (id: string, value: string) => {
    KEYCHAIN_STORE.set(id, value)
  })
}))

const TEST_ROOT = '/tmp/orca-claude-multi-provider-test'

type IntegrationFixture = {
  service: import('./service').ClaudeAccountService
  getSettings: () => GlobalSettings
  setSettings: (next: Partial<GlobalSettings>) => void
}

async function createFixture(): Promise<IntegrationFixture> {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })

  let settings = {
    claudeManagedAccounts: [] as ClaudeManagedAccount[],
    activeClaudeManagedAccountId: null as string | null
  } as unknown as GlobalSettings

  const store = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }

  const runtimeAuth = {
    clearLastWrittenCredentialsJson: vi.fn(),
    syncForCurrentSelection: vi.fn(async () => {}),
    forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
  }

  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
  }

  const { ClaudeAccountService } = await import('./service')
  const service = new ClaudeAccountService(
    store as never,
    rateLimits as never,
    runtimeAuth as never
  )

  return {
    service,
    getSettings: () => settings,
    setSettings: (next) => {
      settings = { ...settings, ...next }
    }
  }
}

// Materialize the currently active managed Claude account into an env patch.
// Mirrors the production runtime-auth-service path (handlerFor → materialize →
// applyEnvFromMaterialization) but stays in-process so we can assert on the
// resulting env without writing to disk/keychain.
async function materializeActiveEnv(fixture: IntegrationFixture): Promise<Record<string, string>> {
  const { handlerFor } = await import('./providers')
  const { applyEnvFromMaterialization } = await import('./environment')
  const { migrateClaudeAccount } = await import('./migration')

  const settings = fixture.getSettings()
  const activeId = settings.activeClaudeManagedAccountId
  if (!activeId) {
    return {}
  }
  const raw = settings.claudeManagedAccounts.find((acct) => acct.id === activeId)
  if (!raw) {
    return {}
  }
  const account = migrateClaudeAccount(raw)
  const handler = handlerFor(account.authMethod)
  const materialization = await handler.materialize(account)
  return applyEnvFromMaterialization({}, materialization)
}

beforeEach(() => {
  KEYCHAIN_STORE.clear()
})

describe('Multi-provider P1 integration', () => {
  it('add anthropic-api-key → materialize → env has ANTHROPIC_API_KEY only', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'Work',
      secretFromUser: 'sk-ant-real'
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-real')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('add zai compat → emits BASE_URL + AUTH_TOKEN + model defaults, no API_KEY', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'anthropic-compat',
      label: 'z.ai',
      secretFromUser: 'zai-token',
      providerConfig: { preset: 'zai' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-token')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.1')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.1')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('add kimi → opus/sonnet/haiku all kimi-k2.6', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'anthropic-compat',
      label: 'Kimi',
      secretFromUser: 'kimi-token',
      providerConfig: { preset: 'kimi' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('kimi-token')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.6')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.6')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.6')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('add minimax → opus/sonnet MiniMax-M2.7, haiku MiniMax-M2.7-highspeed', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'anthropic-compat',
      label: 'MiniMax',
      secretFromUser: 'mm-token',
      providerConfig: { preset: 'minimax' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('mm-token')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7-highspeed')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('add custom compat with explicit baseUrl → uses that baseUrl, no model env', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'anthropic-compat',
      label: 'Self-hosted',
      secretFromUser: 'tok',
      providerConfig: { preset: 'custom', baseUrl: 'https://example.com' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.com')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok')
    // custom preset has no baked-in model defaults
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('switch providers → old provider env keys stripped (allowlist behavior, autoplan E1)', async () => {
    const fixture = await createFixture()

    await fixture.service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'Key',
      secretFromUser: 'sk-ant'
    })
    const beforeSwitch = await materializeActiveEnv(fixture)
    expect(beforeSwitch.ANTHROPIC_API_KEY).toBe('sk-ant')

    await fixture.service.addAccount({
      authMethod: 'anthropic-compat',
      label: 'z.ai',
      secretFromUser: 'zai',
      providerConfig: { preset: 'zai' }
    })
    // Adding a polymorphic account auto-selects it as active.
    const afterSwitch = await materializeActiveEnv(fixture)

    expect(afterSwitch.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(afterSwitch.ANTHROPIC_AUTH_TOKEN).toBe('zai')
    // E1: the previously-active provider's keys must not survive the switch.
    expect(afterSwitch.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('OAuth back-compat: existing OAuth account materializes with CLAUDE_CONFIG_DIR', async () => {
    const fixture = await createFixture()
    const managedAuthPath = join(TEST_ROOT, 'claude-accounts', 'oauth-fixture', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'oauth-fixture\n', 'utf-8')
    writeFileSync(join(managedAuthPath, '.credentials.json'), '{"claudeAiOauth":{}}\n', 'utf-8')

    // Seed an OAuth account directly into settings without going through the
    // OAuth login flow (which would shell out to `claude`).
    const oauthAccount: ClaudeManagedAccount = {
      id: 'oauth-fixture',
      email: 'oauth@example.com',
      managedAuthPath,
      authMethod: 'subscription-oauth',
      credentials: { authMethod: 'subscription-oauth' },
      modelMapping: {},
      fallbackAccountIds: [],
      organizationUuid: null,
      organizationName: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    fixture.setSettings({
      claudeManagedAccounts: [oauthAccount],
      activeClaudeManagedAccountId: 'oauth-fixture'
    } as unknown as Partial<GlobalSettings>)

    const env = await materializeActiveEnv(fixture)

    expect(env.CLAUDE_CONFIG_DIR).toBe(managedAuthPath)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
})
