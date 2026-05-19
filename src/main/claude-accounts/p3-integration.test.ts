// Why: P3 end-to-end coverage — exercises the full add-account → materialize
// flow for AWS Bedrock (static-token + IAM-chain) and Google Vertex (ADC), plus
// the autoplan-locked invariants:
//   - E1: switching providers strips the previous provider's env (allowlist)
//   - Bedrock cross-region inference-profile prefix is applied at materialize
//     time (`us.` for `us-east-1`)
//   - Vertex emits no bearer token / no AWS env (ADC-only)
//   - Preset registry override beats the baked default for compat providers
//   - E2: in-process LRU keychain cache suppresses N+1 Keychain reads on the
//     PTY-spawn hot path (one read per materialize cycle until a write
//     invalidates).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import type { ClaudeManagedAccount, GlobalSettings } from '../../shared/types'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-claude-p3-integration-test'
  }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => 'claude'
}))

// Why: mock the lower-level `security` shell-out, NOT the whole `./keychain`
// module — that keeps the real LRU (size 50) inside keychain.ts wired up so
// the cache-hit test below actually measures the production cache behavior.
const securityCalls: { action: 'find' | 'add' | 'delete'; service: string; account: string }[] = []
const securityStore = new Map<string, string>()
const keyFor = (service: string, account: string): string => `${service}::${account}`

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  type Cb = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
  // keychain.ts calls execFile in the 4-arg callback form:
  //   execFile('security', args, { timeout }, cb)
  // Some providers (aws-bedrock, google-vertex) call promisify(execFile)(cmd, args)
  // — that form passes no callback. Handle both shapes here.
  function execFile(cmd: string, args: readonly string[], ...rest: unknown[]): void {
    const cb = rest.find((r) => typeof r === 'function') as Cb | undefined
    if (cmd !== 'security') {
      // Pass through anything that isn't a Keychain probe (e.g. aws / gcloud)
      // — tests that need those mock `./providers/*` directly.
      const err = new Error(`execFile not stubbed for ${cmd}`)
      if (cb) cb(err, '', '')
      else throw err
      return
    }
    const sub = args[0]
    const finish = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string): void => {
      if (cb) cb(err, stdout, stderr)
    }
    if (sub === 'find-generic-password') {
      const sIdx = args.indexOf('-s')
      const aIdx = args.indexOf('-a')
      const service = args[sIdx + 1]
      const account = args[aIdx + 1]
      securityCalls.push({ action: 'find', service, account })
      const v = securityStore.get(keyFor(service, account))
      if (v === undefined) {
        const err = new Error('not found') as NodeJS.ErrnoException
        err.code = '44'
        finish(err, '', 'The specified item could not be found in the keychain.')
      } else {
        finish(null, v, '')
      }
      return
    }
    if (sub === 'add-generic-password') {
      const sIdx = args.indexOf('-s')
      const aIdx = args.indexOf('-a')
      const wIdx = args.indexOf('-w')
      const service = args[sIdx + 1]
      const account = args[aIdx + 1]
      const value = args[wIdx + 1]
      securityCalls.push({ action: 'add', service, account })
      securityStore.set(keyFor(service, account), value)
      finish(null, '', '')
      return
    }
    if (sub === 'delete-generic-password') {
      const sIdx = args.indexOf('-s')
      const aIdx = args.indexOf('-a')
      const service = args[sIdx + 1]
      const account = args[aIdx + 1]
      securityCalls.push({ action: 'delete', service, account })
      securityStore.delete(keyFor(service, account))
      finish(null, '', '')
      return
    }
    finish(new Error(`unknown security subcommand ${sub}`), '', '')
  }
  return {
    ...actual,
    execFile
  }
})

// Why: keep the registry hermetic. P3 T11/T12 already cover the disk/TTL/HTTP
// surface; here we only assert that an override flows through to materialize.
const registryMock = vi.hoisted(() => ({
  fetchPresetRegistry: vi.fn(async () => null as unknown)
}))
vi.mock('./preset-registry', () => ({
  fetchPresetRegistry: registryMock.fetchPresetRegistry,
  getCachedRegistry: vi.fn(async () => ({ data: null, fetchedAt: null })),
  clearPresetRegistryCache: vi.fn(async () => {}),
  REGISTRY_TTL_MS: 24 * 60 * 60 * 1000
}))

const TEST_ROOT = '/tmp/orca-claude-p3-integration-test'

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
    activeClaudeManagedAccountId: null as string | null,
    claudeAccountIdByWorkspace: {}
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
// resulting env without writing to disk.
async function materializeActiveEnv(fixture: IntegrationFixture): Promise<Record<string, string>> {
  const { handlerFor } = await import('./providers')
  const { applyEnvFromMaterialization } = await import('./environment')
  const { migrateClaudeAccount } = await import('./migration')

  const settings = fixture.getSettings()
  const activeId = settings.activeClaudeManagedAccountId
  if (!activeId) return {}
  const raw = settings.claudeManagedAccounts.find((acct) => acct.id === activeId)
  if (!raw) return {}
  const account = migrateClaudeAccount(raw)
  const handler = handlerFor(account.authMethod)
  const materialization = await handler.materialize(account)
  return applyEnvFromMaterialization({}, materialization)
}

beforeEach(async () => {
  securityCalls.length = 0
  securityStore.clear()
  registryMock.fetchPresetRegistry.mockReset().mockResolvedValue(null)
  // Why: the production keychain module owns a module-scoped LRU. Reset it
  // between tests so cache state from a prior case can't mask a real miss.
  const { __resetKeychainCacheForTests } = await import('./keychain')
  __resetKeychainCacheForTests()
})

describe('P3 integration — Bedrock + Vertex end-to-end', () => {
  it('add Bedrock (static token) → switch → env materializes with us. prefix', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'aws-bedrock',
      label: 'b',
      secretFromUser: 'bearer-xyz',
      providerConfig: { region: 'us-east-1' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-xyz')
    expect(env.AWS_REGION).toBe('us-east-1')
    // Region-derived inference-profile prefix is applied at materialize time.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('us.anthropic.claude-opus-4-7')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('us.anthropic.claude-sonnet-4-6')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
    // No leftover Vertex / OAuth / API-key env keys.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
  })

  it('add Bedrock (IAM-chain, no bearer) → no AWS_BEARER_TOKEN_BEDROCK emitted', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'aws-bedrock',
      label: 'b-iam',
      providerConfig: { region: 'eu-west-1' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.AWS_REGION).toBe('eu-west-1')
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    // EU region → `eu.` prefix.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('eu.anthropic.claude-opus-4-7')
  })

  it('add Vertex → switch → env materializes correctly, no token / no AWS env', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'google-vertex',
      label: 'v',
      providerConfig: { projectId: 'p', region: 'us-east5' }
    })

    const env = await materializeActiveEnv(fixture)

    expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1')
    expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe('p')
    expect(env.CLOUD_ML_REGION).toBe('us-east5')
    // ADC-only — no bearer tokens are stored or emitted.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    // Vertex emits raw model ids (no region prefix; region is a separate var).
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5@20251001')
  })

  it('switching API-key → Bedrock fully replaces env (allowlist E1)', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'api',
      secretFromUser: 'sk-ant-old'
    })
    const before = await materializeActiveEnv(fixture)
    expect(before.ANTHROPIC_API_KEY).toBe('sk-ant-old')

    // Adding a polymorphic account auto-selects it as active.
    await fixture.service.addAccount({
      authMethod: 'aws-bedrock',
      label: 'b',
      secretFromUser: 'bearer-zzz',
      providerConfig: { region: 'us-east-1' }
    })
    const after = await materializeActiveEnv(fixture)

    expect(after.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(after.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-zzz')
    // E1: previously-active provider keys must not survive the switch.
    expect(after.ANTHROPIC_API_KEY).toBeUndefined()
    expect(after.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('switching Bedrock → Vertex fully replaces env (allowlist E1)', async () => {
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'aws-bedrock',
      label: 'b',
      secretFromUser: 'bearer-zzz',
      providerConfig: { region: 'us-east-1' }
    })
    const before = await materializeActiveEnv(fixture)
    expect(before.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-zzz')

    await fixture.service.addAccount({
      authMethod: 'google-vertex',
      label: 'v',
      providerConfig: { projectId: 'gp', region: 'us-east5' }
    })
    const after = await materializeActiveEnv(fixture)

    expect(after.CLAUDE_CODE_USE_VERTEX).toBe('1')
    // E1: Bedrock-side env must not survive the switch to Vertex.
    expect(after.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(after.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(after.AWS_REGION).toBeUndefined()
  })

  it('preset registry override beats the baked default for compat providers', async () => {
    // Why: this exercises the resolveCompatDefaults path used by the compat
    // handler at materialize time. Registry returns a fresh override → we
    // expect it to land in the env instead of the baked baseline.
    registryMock.fetchPresetRegistry.mockResolvedValue({
      version: 1,
      presets: {
        zai: { opus: 'glm-9.9', sonnet: 'glm-9.9', haiku: 'glm-air-9' }
      }
    })

    const { resolveCompatDefaults } = await import('./model-defaults')
    const overridden = await resolveCompatDefaults('zai')
    expect(overridden.opus).toBe('glm-9.9')
    expect(overridden.sonnet).toBe('glm-9.9')
    expect(overridden.haiku).toBe('glm-air-9')

    // Registry miss falls back to the baked default — never throws.
    registryMock.fetchPresetRegistry.mockResolvedValueOnce(null)
    const baseline = await resolveCompatDefaults('zai')
    expect(baseline.opus).toBe('glm-5.1') // baked
  })

  it('LRU cache survives across PTY spawns — keychain probed once per add/switch', async () => {
    // Why: validates autoplan E2 — the in-process keychain LRU eliminates the
    // N+1 `security` shell-out on workspace launch. After one add + one
    // materialize, repeated materialize cycles should never re-shell out for
    // the same accountId until a write/remove invalidates the entry.
    const fixture = await createFixture()
    await fixture.service.addAccount({
      authMethod: 'aws-bedrock',
      label: 'b',
      secretFromUser: 'bearer-cache',
      providerConfig: { region: 'us-east-1' }
    })

    // First materialize warms the cache.
    const first = await materializeActiveEnv(fixture)
    expect(first.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-cache')

    // Count `find-generic-password` reads against the Orca managed service so
    // far — subsequent materializes should not increase this counter.
    const findsAfterWarm = securityCalls.filter(
      (c) => c.action === 'find' && c.service === 'Orca Claude Code Managed Credentials'
    ).length

    for (let i = 0; i < 50; i++) {
      await materializeActiveEnv(fixture)
    }

    const findsAfterLoop = securityCalls.filter(
      (c) => c.action === 'find' && c.service === 'Orca Claude Code Managed Credentials'
    ).length

    expect(findsAfterLoop).toBe(findsAfterWarm)
  })
})
