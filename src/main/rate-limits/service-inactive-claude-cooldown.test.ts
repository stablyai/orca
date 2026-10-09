import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type CooldownFixture = {
  userData: string
  origin: string
  now: number
  status: number
  retryAfter: string | null
  hold: boolean
  pending: ServerResponse | null
  arrived: () => void
  requests: string[]
}

const fixture = vi.hoisted((): CooldownFixture => ({
  userData: '',
  origin: '',
  now: 1800000000000,
  status: 200,
  retryAfter: '3600',
  hold: false,
  pending: null,
  arrived: () => {},
  requests: []
}))

vi.mock('electron', () => ({
  app: { getPath: () => fixture.userData },
  session: { defaultSession: {} },
  net: {
    fetch: (url: string, options: RequestInit) => {
      if (url !== 'https://api.anthropic.com/api/oauth/usage') {
        throw new Error('Unexpected endpoint in local usage fixture')
      }
      return globalThis.fetch(fixture.origin, options)
    }
  }
}))

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => {})
}))
vi.mock('./claude-pty', () => ({
  fetchViaPty: vi.fn(async () => {
    throw new Error('Usage fixture must not launch Claude')
  })
}))
vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir: string) => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    if (!configDir.startsWith(fixture.userData)) {
      throw new Error('Usage fixture must read its own account folder')
    }
    return readFile(join(configDir, '.credentials.json'), 'utf8')
  })
}))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: () => ({ status: 'missing' }) }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: async () => ({ status: 'missing' }) }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: () => false }))
vi.mock('../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: () => false }))
vi.mock('../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: () => false }))
vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: async () => ({
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  }),
  consumeCodexRateLimitResetCredit: vi.fn()
}))
vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: async () => ({
    provider: 'gemini',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: async () => ({
    provider: 'kimi',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: async () => ({
    provider: 'opencode-go',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: async () => ({
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: async () => ({
    provider: 'grok',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: async () => ({
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: async () => ({
    provider: 'zcode',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))
vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: async () => ({
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: fixture.now,
    error: null,
    status: 'unavailable'
  })
}))

import { RateLimitService } from './service'
import { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'

let activeId = 'A'
let inactiveIds = ['A', 'B']
let service: RateLimitService
let restoreClock: () => void
let router: ClaudeProfileRouter

function account(id: string) {
  return { id }
}

function preparation(id: string) {
  return router.accountUsagePreparation(id)
}

function reply(response: ServerResponse, status: number) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  if (status === 429 && fixture.retryAfter) {
    response.setHeader('Retry-After', fixture.retryAfter)
  }
  response.end(
    JSON.stringify(
      status === 200
        ? {
            five_hour: { utilization: 21, resets_at: '2027-01-16T14:00:00Z' },
            seven_day: { utilization: 11, resets_at: '2027-01-20T14:00:00Z' }
          }
        : { error: { message: 'Synthetic usage failure' } }
    )
  )
}

const server = createServer((request, response) => {
  const id =
    request.headers.authorization === 'Bearer synthetic-A'
      ? 'A'
      : request.headers.authorization === 'Bearer synthetic-B'
        ? 'B'
        : null
  if (!id) {
    response.writeHead(403).end()
    return
  }
  fixture.requests.push(id)
  if (id === 'A' && fixture.hold) {
    fixture.pending = response
    fixture.arrived()
    return
  }
  reply(response, id === 'A' ? fixture.status : 200)
})

function count(id: string) {
  return fixture.requests.filter((requestId) => requestId === id).length
}

function cached(id: string) {
  return service.getState().inactiveClaudeAccounts.find((row) => row.accountId === id)?.rateLimits
}

beforeEach(async () => {
  fixture.userData = mkdtempSync(join(tmpdir(), 'orca-inactive-claude-429-'))
  fixture.now = 1800000000000
  fixture.status = 200
  fixture.retryAfter = '3600'
  fixture.hold = false
  fixture.pending = null
  fixture.requests = []
  activeId = 'A'
  inactiveIds = ['A', 'B']
  for (const id of inactiveIds) {
    const path = join(fixture.userData, 'claude-profiles', id, 'home')
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: `synthetic-${id}`, expiresAt: 1900000000000 }
      })
    )
  }
  router = new ClaudeProfileRouter({
    dataRoot: fixture.userData,
    userHome: join(fixture.userData, 'user-home'),
    env: { CLAUDE_CONFIG_DIR: join(fixture.userData, 'system-default') },
    getSettings: () => ({
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: activeId,
      activeClaudeManagedAccountIdsByRuntime: { host: activeId, wsl: {} },
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    }),
    runSetup: async () => {
      throw new Error('Usage fixture must not set up an account')
    }
  })
  installClaudeProfileRouter(router)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected local listener')
  }
  fixture.origin = `http://127.0.0.1:${address.port}`
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => fixture.now)
  restoreClock = () => clock.mockRestore()
  service = new RateLimitService()
  service.setClaudeAuthPreparationResolver(async () => preparation(activeId))
  service.setInactiveClaudeAccountsResolver(() => inactiveIds.map(account))
})

afterEach(async () => {
  service.stop()
  installClaudeProfileRouter(undefined)
  restoreClock()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(fixture.userData, { recursive: true, force: true })
})

it('keeps A last-good usage, skips its one-hour server wait, and refreshes healthy B until exact expiry', async () => {
  await service.fetchInactiveClaudeAccountsOnOpen()
  const originalAt = cached('A')?.updatedAt
  fixture.now += 61000
  fixture.status = 429
  await service.fetchInactiveClaudeAccountsOnOpen()
  const retryAt = fixture.now + 3600000
  expect(cached('A')).toMatchObject({
    status: 'error',
    updatedAt: originalAt,
    session: { usedPercent: 21 },
    usageMetadata: {
      failureKind: 'rate-limited',
      retryAtMs: retryAt,
      authProvenance: 'profile:A',
      credentialSource: process.platform === 'darwin' ? 'scoped-keychain' : 'credentials-file'
    }
  })
  fixture.now += 61000
  await service.fetchInactiveClaudeAccountsOnOpen()
  expect(count('A')).toBe(2)
  expect(count('B')).toBe(3)
  expect(cached('A')?.updatedAt).toBe(originalAt)
  expect(service.getState().inactiveClaudeAccounts.every((row) => !row.isFetching)).toBe(true)
  fixture.now = retryAt
  fixture.status = 200
  await service.fetchInactiveClaudeAccountsOnOpen()
  expect(count('A')).toBe(3)
  expect(count('B')).toBe(4)
  expect(cached('A')).toMatchObject({ status: 'ok', updatedAt: retryAt })
})

it('honors a deadline seeded from live active usage and preserves forced account-change retries', async () => {
  inactiveIds = ['B']
  await service.refreshClaudeForTarget()
  fixture.now += 61000
  fixture.status = 429
  await service.refreshClaudeForTarget()
  service.ingestLiveClaudeRateLimits({
    configDir: preparation('A').configDir,
    fiveHour: { utilization: 23, resets_at: '2027-01-16T14:00:00Z' },
    sevenDay: null
  })
  activeId = 'B'
  inactiveIds = ['A']
  await service.refreshForClaudeAccountChange('A')
  expect(cached('A')).toMatchObject({
    status: 'ok',
    usageMetadata: { source: 'live-session', retryAtMs: fixture.now + 3600000 }
  })
  await service.fetchInactiveClaudeAccountsOnOpen()
  expect(count('A')).toBe(2)
  expect(count('B')).toBe(1)
  expect(service.getState().inactiveClaudeAccounts[0]?.isFetching).toBe(false)
  activeId = 'A'
  inactiveIds = ['B']
  await service.refreshForClaudeAccountChange('B')
  await service.refresh()
  expect(count('A')).toBe(4)
})

it.each([401, 503])(
  'preserves current profile failure metadata without a wait for HTTP %s',
  async (status) => {
    await service.fetchInactiveClaudeAccountsOnOpen()
    const originalAt = cached('A')?.updatedAt
    fixture.now += 61000
    fixture.status = status
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(cached('A')).toMatchObject({
      status: 'error',
      updatedAt: originalAt,
      session: { usedPercent: 21 },
      usageMetadata: { failureKind: status === 401 ? 'stale-token' : 'server' }
    })
    expect(cached('A')?.usageMetadata?.retryAtMs).toBeUndefined()
    fixture.now += 61000
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(count('A')).toBe(3)
  }
)

it('does not invent a wait when a 429 has no Retry-After header', async () => {
  fixture.status = 429
  fixture.retryAfter = null
  await service.fetchInactiveClaudeAccountsOnOpen()
  expect(cached('A')).toMatchObject({
    status: 'error',
    usageMetadata: { failureKind: 'rate-limited' }
  })
  expect(cached('A')?.usageMetadata?.retryAtMs).toBeUndefined()
  fixture.now += 61000
  await service.fetchInactiveClaudeAccountsOnOpen()
  expect(count('A')).toBe(2)
})

it.each(['remove', 'stop'])('discards a late 429 after account %s', async (action) => {
  fixture.hold = true
  const arrived = new Promise<void>((resolve) => {
    fixture.arrived = resolve
  })
  const pending = service.fetchInactiveClaudeAccountsOnOpen()
  await arrived
  if (action === 'stop') {
    service.stop()
  } else {
    inactiveIds = ['B']
    service.evictInactiveClaudeCache('A')
  }
  if (!fixture.pending) {
    throw new Error('Expected pending local response')
  }
  reply(fixture.pending, 429)
  await pending
  expect(cached('A')).toBeUndefined()
  expect(service.getState().inactiveClaudeAccounts.every((row) => !row.isFetching)).toBe(true)
})
