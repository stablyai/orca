import SyncDatabase from '../sqlite/sync-database'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { RateLimitService } from '../rate-limits/service'
import { DEFAULT_POLL_MS } from '../rate-limits/service/service-types'
import { setMainHttpClient } from '../network/http-client'
import { createOpenCodeTextSubscriptionPreparation } from './opencode-text-subscriptions'
import { beginTextGenerationRequest } from './source-control-generation-lanes'
import { runGenerationRequest } from './agent-generation-request'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: () => join(state.root, 'home')
}))
vi.mock('../network/proxy-settings', () => ({ ensureElectronProxyFromEnvironment: async () => {} }))
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-opencode-text-'))
  installFakeAppEnvironment({ getPath: () => state.root })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})

async function fixture(
  options: {
    duplicate?: boolean
    enabled?: boolean
    agent?: 'opencode' | 'opencode2'
    config?: { location: 'global' | 'project'; mcp: unknown }
    usageAgeMs?: number
  } = {}
) {
  const root = state.root
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'opencode'),
    `#!${process.execPath}\n${readFileSync(join(import.meta.dirname, '__fixtures__/opencode-subscription-cli.cjs'), 'utf8')}`,
    { mode: 0o755 }
  )
  writeFileSync(join(bin, 'opencode2'), readFileSync(join(bin, 'opencode')), { mode: 0o755 })
  const accounts = getManagedDataAccountService()
  const ids: string[] = []
  for (const key of ['a', options.duplicate ? 'a' : 'b']) {
    const source = join(root, `source-${ids.length}`)
    mkdirSync(join(source, 'opencode'), { recursive: true })
    writeFileSync(
      join(source, 'opencode', 'auth.json'),
      JSON.stringify({ 'opencode-go': { type: 'api', key } })
    )
    const database = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    database.exec(
      'CREATE TABLE session (id TEXT); CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)'
    )
    database
      .prepare('INSERT INTO credential VALUES (?, ?, 1, 1)')
      .run('opencode-go', JSON.stringify({ type: 'key', key }))
    database.close()
    const id = (await accounts.add('opencode', source, key)).activeAccountId!
    const owned = accounts.environmentForAccount('opencode', id)
    writeFileSync(
      join(owned.XDG_DATA_HOME, 'opencode', 'auth.json'),
      JSON.stringify({ 'opencode-go': { type: 'api', key } })
    )
    ids.push(id)
  }
  await accounts.select('opencode', ids[0])
  const selected = accounts.environmentForAccount('opencode', ids[0])
  const registry = readFileSync(
    join(root, 'managed-data-accounts', 'opencode', 'accounts.json'),
    'utf8'
  )
  const select = vi.spyOn(accounts, 'select')
  const rateLimits = new RateLimitService()
  let usageRequests = 0
  let usageFetches = 0
  setMainHttpClient({
    proxySession: () => null,
    fetch: async (_url, input) => {
      usageFetches += 1
      const key = new Headers(input?.headers).get('Authorization')?.replace('Bearer ', '')
      const window = (percent: number) => ({
        percent,
        resetsAt: new Date(Date.now() + 86400000).toISOString()
      })
      return new Response(
        JSON.stringify({
          usage: {
            rolling: window(
              key === 'a' && (!options.duplicate || usageRequests++ === 0) ? 100 : 10
            ),
            weekly: window(20),
            monthly: window(20)
          }
        })
      )
    }
  })
  const log = join(root, 'attempts.jsonl')
  writeFileSync(log, '')
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    ORCA_TEST_SUBSCRIPTIONS_LOG: log,
    ORCA_TEST_QUOTA_FIXTURE: join(
      import.meta.dirname,
      '__fixtures__/opencode-1.19.4-quota-refusal.jsonl'
    )
  }
  const settings = createGlobalSettingsFixture({
    textGenerationSubscriptionFailoverEnabled: options.enabled !== false
  })
  const params = { agentId: options.agent ?? 'opencode', model: 'opencode-go/fixture-model' }
  const configPath = options.config
    ? options.config.location === 'global'
      ? join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')
      : join(root, '.opencode', 'opencode.jsonc')
    : undefined
  if (configPath && options.config) {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ mcp: options.config.mcp }))
  }
  if (options.usageAgeMs !== undefined) {
    await rateLimits.refreshOpenCodeTextAccounts({
      signal: new AbortController().signal,
      backend: 'v1',
      environment: env,
      cwd: root,
      accountIds: ids,
      freshUntil: Date.now()
    })
    expect(rateLimits.getOpenCodeTextAccountUsage(ids[1], 'v1')).toBeDefined()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + options.usageAgeMs)
  }
  const setupFetches = usageFetches
  const request = beginTextGenerationRequest('branch-name', root, 60000, () => true)
  const prepare = createOpenCodeTextSubscriptionPreparation({
    store: { getSettings: () => settings },
    rateLimits
  })
  const subscription = prepare({ params, cwd: root, env, request })
  const run = async () => {
    try {
      return await runGenerationRequest({
        params,
        prompt: 'Name this fixed context',
        target: { kind: 'local', cwd: root, env: { ...env, ...selected }, request, subscription },
        operation: 'branch-name',
        spawnAgent: spawnSourceControlAgent
      })
    } finally {
      request.finish()
      rateLimits.stop()
    }
  }
  return {
    root,
    ids,
    selected,
    accounts,
    select,
    registry,
    request,
    env,
    params,
    prepare,
    configPath,
    run,
    requestUsageFetches: () => usageFetches - setupFetches,
    attempts: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  }
}

describe.skipIf(process.platform === 'win32')(
  'managed OpenCode text subscription subprocess delivery',
  () => {
    it.each(['opencode', 'opencode2'] as const)(
      '%s delivers B credentials after confirmed Go quota refusal without selecting B globally',
      async (agent) => {
        const f = await fixture({ agent })
        const result = await f.run()
        const attempts = f.attempts()
        expect(attempts.map((a) => a.account)).toEqual(['a', 'b'])
        expect(result).toMatchObject({ success: true, rawOutput: 'fix-auth' })
        expect(attempts[1].home).toBe(
          f.accounts.environmentForAccount('opencode', f.ids[1]).XDG_DATA_HOME
        )
        expect(attempts[0].args).toEqual(attempts[1].args)
        expect(attempts[0].input).toBe(attempts[1].input)
        expect(f.select).not.toHaveBeenCalled()
        expect(
          readFileSync(join(f.root, 'managed-data-accounts', 'opencode', 'accounts.json'), 'utf8')
        ).toBe(f.registry)
      }
    )
    it('refreshes cached usage older than the poll interval before recovering', async () => {
      const f = await fixture({ usageAgeMs: DEFAULT_POLL_MS + 1000 })
      expect(await f.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
      expect(f.requestUsageFetches()).toBe(2)
    })
    it('refreshes once when cached usage would expire before the request deadline', async () => {
      const f = await fixture({ usageAgeMs: DEFAULT_POLL_MS - 30_000 })
      expect(await f.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
      expect(f.requestUsageFetches()).toBe(2)
    })
    it('reuses usage that stays fresh through the request without refreshing', async () => {
      const f = await fixture({ usageAgeMs: 1000 })
      expect(await f.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
      expect(f.requestUsageFetches()).toBe(0)
    })
    it('surfaces the provider quota message as failure detail', async () => {
      const f = await fixture({ duplicate: true })
      expect(await f.run()).toMatchObject({
        success: false,
        subscriptionQuotaRefused: true,
        subscriptionRecovery: { firstError: expect.stringContaining('Subscription quota exceeded') }
      })
    })
    it('does not retry the same credentials saved in another profile', async () => {
      const f = await fixture({ duplicate: true })
      expect(await f.run()).toMatchObject({ success: false, subscriptionQuotaRefused: true })
      expect(f.attempts().map((a) => a.account)).toEqual(['a'])
    })
    it('keeps the selected managed account for ordinary execution and respects explicit account pins', async () => {
      const f = await fixture({ enabled: false })
      const prepared = await prepareLocalCommitMessageAgentEnv('opencode', {
        resolveBaseEnvironment: async () => f.env
      })
      expect(prepared).toMatchObject({ ok: true, env: { XDG_DATA_HOME: f.selected.XDG_DATA_HOME } })
      expect(
        f.prepare({
          params: f.params,
          cwd: f.root,
          env: { ...f.env, ORCA_DATA_ACCOUNT_ID: f.ids[0] },
          request: f.request
        })
      ).toBeUndefined()
      expect(await f.run()).toMatchObject({ success: false })
      expect(f.attempts()).toHaveLength(1)
    })
    it('respects an explicit managed account pin while recovery is enabled', async () => {
      const f = await fixture()
      expect(
        f.prepare({
          params: f.params,
          cwd: f.root,
          env: { ...f.env, ORCA_DATA_ACCOUNT_ID: f.ids[0] },
          request: f.request
        })
      ).toBeUndefined()
      f.request.finish()
    })
    it.each(['global', 'project'] as const)(
      'preserves %s custom MCP configuration and uses ordinary A only',
      async (location) => {
        const f = await fixture({
          config: { location, mcp: { custom: { type: 'local', command: ['fixture-mcp'] } } }
        })
        const original = readFileSync(f.configPath!, 'utf8')
        expect(await f.run()).toMatchObject({ success: false })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
        expect(readFileSync(f.configPath!, 'utf8')).toBe(original)
      }
    )
    it.each([null, []])(
      'refuses malformed MCP configuration %j without an alternate',
      async (mcp) => {
        const f = await fixture({ config: { location: 'global', mcp } })
        expect(await f.run()).toMatchObject({ success: false })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
      }
    )
    it('retains recovery for an empty MCP table', async () => {
      const f = await fixture({ config: { location: 'global', mcp: {} } })
      expect(await f.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a', 'b'])
    })
  }
)
