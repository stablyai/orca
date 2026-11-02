import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as KeychainPassword from '../macos-keychain/generic-password'
import {
  forgetClaudePaneAccount,
  recordClaudePaneAccount
} from '../claude-accounts/claude-pane-account-registry'

const keychain = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<string | null> => null),
  write: vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' }))
}))

vi.mock('../macos-keychain/generic-password', async () => {
  const actual = await vi.importActual<typeof KeychainPassword>(
    '../macos-keychain/generic-password'
  )
  return {
    ...actual,
    readKeychainPassword: keychain.read,
    execSecurityCommand: keychain.write
  }
})

import {
  CLAUDE_CODE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_DEFAULT_SCOPES,
  CLAUDE_OAUTH_TOKEN_URL,
  beginClaudeOAuthRefreshCycle,
  claudeOAuthRefreshStatus,
  refreshClaudeOAuthAccessToken,
  resetClaudeOAuthRefreshStateForTests
} from './claude-oauth-refresh'
import { CLAUDE_OAUTH_TOKEN_HEADERS } from './claude-oauth-node-fetch'
import type { ClaudeOAuthCredentialDocument } from './claude-oauth-credential-document'
import type { ClaudeOAuthRefreshDeps } from './claude-oauth-refresh-state'
import {
  CLAUDE_OAUTH_REFRESH_MIN_GAP_MS,
  planClaudeUsageRefreshSlice
} from './claude-oauth-refresh-pacing'
import {
  claimClaudeUsageRefresh,
  claudeOAuthRefreshCycleId,
  claudeOAuthRefreshRows
} from './claude-oauth-refresh-state'

const NOW = 1_700_000_000_000
const FIVE_MIN = 5 * 60 * 1000
const THIRTY_MIN = 30 * 60 * 1000
const PANE = 'pty-oauth-refresh'

type FetchCall = { url: string; init: RequestInit }

function document(overrides: Record<string, unknown> = {}): ClaudeOAuthCredentialDocument {
  const oauth: Record<string, unknown> = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 1,
    refreshTokenExpiresAt: 9,
    clientId: 'client-stored',
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    organizationUuid: 'org-keep',
    ...overrides
  }
  return {
    parsed: { claudeAiOauth: oauth, mcpServers: { kept: true } },
    oauth,
    refreshToken: String(oauth.refreshToken),
    store: { kind: 'file', path: '/tmp/acct/.credentials.json' }
  }
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    refresh_token_expires_in: 7200,
    scope: 'user:inference user:profile',
    ...overrides
  }
}

beforeEach(() => {
  resetClaudeOAuthRefreshStateForTests()
  keychain.read.mockReset()
  keychain.read.mockResolvedValue(null)
  keychain.write.mockReset()
  keychain.write.mockResolvedValue({ stdout: '', stderr: '' })
  forgetClaudePaneAccount(PANE)
})

afterEach(() => {
  resetClaudeOAuthRefreshStateForTests()
  forgetClaudePaneAccount(PANE)
  vi.restoreAllMocks()
})

function harness(options?: {
  doc?: ClaudeOAuthCredentialDocument
  now?: () => number
  fetch?: ClaudeOAuthRefreshDeps['fetch']
  write?: ClaudeOAuthRefreshDeps['writeDocument']
  live?: boolean
  enabled?: boolean
  read?: ClaudeOAuthRefreshDeps['readDocument']
  delay?: ClaudeOAuthRefreshDeps['delay']
  jitterMs?: ClaudeOAuthRefreshDeps['jitterMs']
}): { calls: FetchCall[]; writes: { json: string }[]; deps: Partial<ClaudeOAuthRefreshDeps> } {
  const calls: FetchCall[] = []
  const writes: { json: string }[] = []
  const doc = options?.doc ?? document()
  return {
    calls,
    writes,
    deps: {
      now: options?.now ?? (() => NOW),
      enabled: () => options?.enabled !== false,
      hasLiveSession: () => options?.live === true,
      readDocument: options?.read ?? (async () => ({ ok: true as const, document: doc })),
      writeDocument:
        options?.write ??
        (async (pending) => {
          writes.push({ json: pending.json })
        }),
      fetch:
        options?.fetch ??
        (async (url, init) => {
          calls.push({ url, init })
          return tokenResponse(successBody())
        }),
      delay: options?.delay ?? (async () => {}),
      jitterMs: options?.jitterMs ?? (() => 0)
    }
  }
}

it('posts Claude Code’s refresh body and writes every other field back first', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const { calls, writes, deps } = harness()
  const result = await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })
  expect(result).toEqual({ outcome: 'refreshed', accessToken: 'new-access' })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(CLAUDE_OAUTH_TOKEN_URL)
  expect(calls[0]?.init.method).toBe('POST')
  expect(calls[0]?.init.redirect).toBe('manual')
  expect(calls[0]?.init.headers).toEqual({ ...CLAUDE_OAUTH_TOKEN_HEADERS })
  const body = JSON.parse(String(calls[0]?.init.body))
  expect(body).toEqual({
    grant_type: 'refresh_token',
    refresh_token: 'old-refresh',
    client_id: 'client-stored',
    scope: 'user:inference user:profile'
  })
  expect(body).not.toHaveProperty('expires_in')
  expect(writes).toHaveLength(1)
  const written = JSON.parse(writes[0]?.json ?? '{}')
  expect(Object.keys(written)).toEqual(['claudeAiOauth', 'mcpServers'])
  expect(Object.keys(written.claudeAiOauth)).toEqual([
    'accessToken',
    'refreshToken',
    'expiresAt',
    'refreshTokenExpiresAt',
    'clientId',
    'scopes',
    'subscriptionType',
    'organizationUuid'
  ])
  expect(written.mcpServers).toEqual({ kept: true })
  expect(written.claudeAiOauth).toMatchObject({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 7_200_000,
    clientId: 'client-stored',
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    organizationUuid: 'org-keep'
  })
  expect(info.mock.calls.map((line) => line.join(' '))).toEqual([
    '[claude-usage] refresh account=acct ok'
  ])
  expect(info.mock.calls.flat().join(' ')).not.toContain('old-refresh')
  expect(info.mock.calls.flat().join(' ')).not.toContain('new-access')
  expect(claudeOAuthRefreshStatus()).toEqual([
    {
      accountId: 'acct',
      lastRefreshAt: NOW,
      nextRetryAt: null,
      lapsed: false,
      queuePosition: null,
      backoffLevel: 0
    }
  ])
})

it('sends the stored client id and, without one, Claude Code’s default scopes', async () => {
  const withClient = harness()
  await refreshClaudeOAuthAccessToken({ accountId: 'with-client', deps: withClient.deps })
  expect(JSON.parse(String(withClient.calls[0]?.init.body)).client_id).toBe('client-stored')

  const bare = harness({
    doc: document({
      clientId: undefined,
      scopes: ['user:inference', 'user:projects:read'],
      subscriptionType: 'max'
    })
  })
  await refreshClaudeOAuthAccessToken({ accountId: 'bare', deps: bare.deps })
  const body = JSON.parse(String(bare.calls[0]?.init.body))
  expect(body.client_id).toBe(CLAUDE_CODE_OAUTH_CLIENT_ID)
  expect(body.scope).toBe([...CLAUDE_OAUTH_DEFAULT_SCOPES, 'user:projects:read'].join(' '))
})

it('keeps the refresh token already stored when the server omits a new one', async () => {
  const { writes, deps } = harness({
    fetch: async () => tokenResponse(successBody({ refresh_token: undefined }))
  })
  await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })
  expect(JSON.parse(writes[0]?.json ?? '{}').claudeAiOauth.refreshToken).toBe('old-refresh')
})

it('skips a live spawn, a disabled setting, a missing refresh token, and a backoff window', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const live = harness({ live: true })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps: live.deps })).toEqual({
    outcome: 'skipped',
    reason: 'live-session'
  })
  const off = harness({ enabled: false })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'off', deps: off.deps })).toEqual({
    outcome: 'skipped',
    reason: 'disabled'
  })
  const missing = harness({
    read: async () => ({ ok: false, reason: 'no-refresh-token' })
  })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'none', deps: missing.deps })).toEqual({
    outcome: 'skipped',
    reason: 'no-refresh-token'
  })
  expect(live.calls).toHaveLength(0)
  expect(off.calls).toHaveLength(0)
  expect(info).not.toHaveBeenCalled()
})

it('does not refresh the spawn account, and does refresh the account the proxy bills', async () => {
  recordClaudePaneAccount({
    ptyId: PANE,
    paneKey: null,
    accountId: 'spawn-acct',
    assignedAccountId: 'billed-acct',
    configDir: null,
    launchedAt: 1,
    pinned: false,
    source: 'spawn'
  })
  const spawn = harness()
  const { hasLiveSession: _ignored, ...spawnDeps } = spawn.deps
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'spawn-acct', deps: spawnDeps })).toEqual(
    { outcome: 'skipped', reason: 'live-session' }
  )
  expect(spawn.calls).toHaveLength(0)

  const billed = harness()
  const { hasLiveSession: _ignoredToo, ...billedDeps } = billed.deps
  expect(
    (await refreshClaudeOAuthAccessToken({ accountId: 'billed-acct', deps: billedDeps })).outcome
  ).toBe('refreshed')
  expect(billed.calls).toHaveLength(1)
})

it('shares one token request and one write between two callers', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let posts = 0
  let started: () => void = () => {}
  const startedGate = new Promise<void>((resolve) => {
    started = resolve
  })
  const { writes, deps } = harness({
    fetch: async () => {
      posts += 1
      started()
      await gate
      return tokenResponse(successBody())
    }
  })
  const first = refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })
  const second = refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })
  await startedGate
  expect(posts).toBe(1)
  release()
  const [a, b] = await Promise.all([first, second])
  expect(a).toEqual(b)
  expect(a).toEqual({ outcome: 'refreshed', accessToken: 'new-access' })
  expect(posts).toBe(1)
  expect(writes).toHaveLength(1)
})

it('treats invalid_grant as lapsed and does not retry that refresh token', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  let posts = 0
  const doc = document()
  const { writes, deps } = harness({
    doc,
    fetch: async () => {
      posts += 1
      return tokenResponse({ error: 'invalid_grant' }, 400)
    }
  })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'lapsed'
  })
  expect(writes).toHaveLength(0)
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'lapsed'
  })
  expect(posts).toBe(1)
  expect(claudeOAuthRefreshStatus()).toEqual([
    {
      accountId: 'acct',
      lastRefreshAt: null,
      nextRetryAt: null,
      lapsed: true,
      queuePosition: null,
      backoffLevel: 0
    }
  ])
  doc.oauth.refreshToken = 'signed-in-again'
  doc.refreshToken = 'signed-in-again'
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'lapsed'
  })
  expect(posts).toBe(2)
  expect(info.mock.calls.map((line) => line.join(' ')).join('\n')).not.toContain('old-refresh')
  expect(info.mock.calls.map((line) => line.join(' ')).join('\n')).toContain('failed=lapsed')
})

it('backs off for 5 minutes and then 30, and does not call the endpoint while waiting', async () => {
  let now = NOW
  let posts = 0
  const { deps } = harness({
    now: () => now,
    fetch: async () => {
      posts += 1
      return tokenResponse({ error: 'server' }, 500)
    }
  })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'failed',
    reason: 'http-500'
  })
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(NOW + FIVE_MIN)
  now = NOW + FIVE_MIN - 1
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'skipped',
    reason: 'backoff'
  })
  expect(posts).toBe(1)
  now = NOW + FIVE_MIN
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'failed',
    reason: 'http-500'
  })
  expect(posts).toBe(2)
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(NOW + FIVE_MIN + THIRTY_MIN)
})

it('retries a failed write before any new token request, even when refresh is off', async () => {
  let now = NOW
  let posts = 0
  let failWrite = true
  const { deps } = harness({
    now: () => now,
    enabled: true,
    fetch: async () => {
      posts += 1
      return tokenResponse(successBody())
    },
    write: async () => {
      if (failWrite) {
        throw new Error('disk full')
      }
    }
  })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'failed',
    reason: 'write-failed'
  })
  expect(posts).toBe(1)
  failWrite = false
  deps.enabled = () => false
  now += 1
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })).toEqual({
    outcome: 'refreshed',
    accessToken: 'new-access'
  })
  expect(posts).toBe(1)
})

it('does not fall through to a credentials file when the keychain read is denied', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-oauth-locked-'))
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'file-access', refreshToken: 'file-refresh' } })
  )
  keychain.read.mockRejectedValue(Object.assign(new Error('interaction not allowed'), { code: 36 }))
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const result = await refreshClaudeOAuthAccessToken({
      accountId: 'locked',
      readOptions: { credentialsFileConfigDir: home, keychainConfigDir: home },
      deps: {
        now: () => NOW,
        delay: async () => {},
        jitterMs: () => 0,
        fetch: async () => tokenResponse(successBody())
      }
    })
    if (process.platform === 'darwin') {
      expect(result).toEqual({ outcome: 'failed', reason: 'keychain-unavailable' })
      expect(keychain.write).not.toHaveBeenCalled()
      expect(info.mock.calls.flat().join(' ')).toContain('failed=keychain-unavailable')
      expect(info.mock.calls.flat().join(' ')).not.toContain('file-refresh')
    } else {
      expect(result.outcome).toBe('refreshed')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('round-trips a credentials file and updates a keychain item in place', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-oauth-file-'))
  const file = join(home, '.credentials.json')
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 1,
        clientId: 'client-stored',
        scopes: ['user:profile'],
        subscriptionType: 'max',
        organizationUuid: 'org-keep'
      },
      extraTop: 'keep-me'
    })
  )
  try {
    const result = await refreshClaudeOAuthAccessToken({
      accountId: 'file-acct',
      readOptions: { credentialsFileConfigDir: home, keychainConfigDir: home },
      deps: {
        now: () => NOW,
        delay: async () => {},
        jitterMs: () => 0,
        fetch: async () =>
          tokenResponse({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            subscription_type: 'pro'
          })
      }
    })
    expect(result).toEqual({ outcome: 'refreshed', accessToken: 'new-access' })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written.extraTop).toBe('keep-me')
    expect(written.claudeAiOauth).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: NOW + 3_600_000,
      clientId: 'client-stored',
      organizationUuid: 'org-keep',
      subscriptionType: 'pro',
      scopes: ['user:profile']
    })
    expect(keychain.write).not.toHaveBeenCalled()

    const keychainDoc = document()
    keychainDoc.store = {
      kind: 'keychain',
      service: 'Claude Code-credentials-test',
      account: 'user'
    }
    await refreshClaudeOAuthAccessToken({
      accountId: 'keychain-acct',
      deps: {
        now: () => NOW,
        delay: async () => {},
        jitterMs: () => 0,
        readDocument: async () => ({ ok: true, document: keychainDoc }),
        fetch: async () => tokenResponse(successBody())
      }
    })
    const args = keychain.write.mock.calls[0]?.[0] ?? []
    expect(args.slice(0, 6)).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      'Claude Code-credentials-test',
      '-a',
      'user'
    ])
    expect(args[6]).toBe('-w')
    expect(JSON.parse(args[7] ?? '{}').claudeAiOauth.accessToken).toBe('new-access')
    expect(JSON.parse(args[7] ?? '{}').mcpServers).toEqual({ kept: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('posts two accounts one at a time and waits out the gap', async () => {
  const order: string[] = []
  const delays: number[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started: () => void = () => {}
  const startedGate = new Promise<void>((resolve) => {
    started = resolve
  })
  const first = harness({
    delay: async (ms) => {
      delays.push(ms)
    },
    fetch: async () => {
      order.push('a')
      started()
      await gate
      return tokenResponse(successBody())
    }
  })
  const second = harness({
    delay: async (ms) => {
      delays.push(ms)
    },
    fetch: async () => {
      order.push('b')
      return tokenResponse(successBody())
    }
  })
  const pendingA = refreshClaudeOAuthAccessToken({ accountId: 'a', deps: first.deps })
  await startedGate
  const pendingB = refreshClaudeOAuthAccessToken({ accountId: 'b', deps: second.deps })
  expect(order).toEqual(['a'])
  release()
  await Promise.all([pendingA, pendingB])
  expect(order).toEqual(['a', 'b'])
  expect(delays).toEqual([CLAUDE_OAUTH_REFRESH_MIN_GAP_MS])
  expect(delays[0]).toBeGreaterThanOrEqual(CLAUDE_OAUTH_REFRESH_MIN_GAP_MS)
})

it('honors Retry-After seconds and an HTTP date, and caps the wait at 30 minutes', async () => {
  const seconds = harness({
    fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '10' } })
  })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'sec', deps: seconds.deps })).toEqual({
    outcome: 'failed',
    reason: 'http-429'
  })
  expect(claudeOAuthRefreshStatus()[0]).toMatchObject({
    nextRetryAt: NOW + 10_000,
    backoffLevel: 1,
    queuePosition: 1
  })

  resetClaudeOAuthRefreshStateForTests()
  const dated = harness({
    fetch: async () =>
      new Response('', {
        status: 429,
        headers: { 'retry-after': new Date(NOW + 15_000).toUTCString() }
      })
  })
  await refreshClaudeOAuthAccessToken({ accountId: 'date', deps: dated.deps })
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(NOW + 15_000)

  resetClaudeOAuthRefreshStateForTests()
  const huge = harness({
    fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '100000' } })
  })
  await refreshClaudeOAuthAccessToken({ accountId: 'huge', deps: huge.deps })
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(NOW + 30 * 60 * 1000)
})

it('logs the 429 retry-after and error code without the body', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const secret = 'do-not-log-secret'
  const flat = harness({
    fetch: async () =>
      new Response(JSON.stringify({ error: 'rate_limit_error', access_token: secret }), {
        status: 429,
        headers: { 'retry-after': '10', 'content-type': 'application/json' }
      })
  })
  expect(await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps: flat.deps })).toEqual({
    outcome: 'failed',
    reason: 'http-429'
  })
  expect(info).toHaveBeenCalledWith(
    '[claude-usage] refresh account=acct failed=http-429 retry-after=10 error=rate_limit_error'
  )

  resetClaudeOAuthRefreshStateForTests()
  const nested = harness({
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.',
            access_token: secret
          }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
  })
  await refreshClaudeOAuthAccessToken({ accountId: 'nested', deps: nested.deps })
  expect(info).toHaveBeenCalledWith(
    '[claude-usage] refresh account=nested failed=http-429 retry-after=- error=rate_limit_error'
  )
  const logged = JSON.stringify(info.mock.calls)
  expect(logged).not.toContain(secret)
  expect(logged).not.toContain('Please try again later')
})

it('raises the shared 429 backoff across polls and does not reset it on a burst', async () => {
  let now = NOW
  let posts = 0
  const { deps } = harness({
    now: () => now,
    fetch: async () => {
      posts += 1
      return new Response('', { status: 429 })
    }
  })
  const refresh = () => refreshClaudeOAuthAccessToken({ accountId: 'acct', deps })
  expect(await refresh()).toEqual({ outcome: 'failed', reason: 'http-429' })
  expect(claudeOAuthRefreshStatus()[0]).toMatchObject({
    nextRetryAt: NOW + 60_000,
    backoffLevel: 1
  })
  beginClaudeOAuthRefreshCycle()
  expect(await refresh()).toEqual({ outcome: 'skipped', reason: 'backoff' })
  expect(await refresh()).toEqual({ outcome: 'skipped', reason: 'backoff' })
  expect(posts).toBe(1)
  expect(claudeOAuthRefreshStatus()[0]?.backoffLevel).toBe(1)

  now = NOW + 60_000
  beginClaudeOAuthRefreshCycle()
  expect(await refresh()).toEqual({ outcome: 'failed', reason: 'http-429' })
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(now + 5 * 60 * 1000)
  expect(claudeOAuthRefreshStatus()[0]?.backoffLevel).toBe(2)

  now = NOW + 60_000 + 5 * 60 * 1000
  expect(await refresh()).toEqual({ outcome: 'failed', reason: 'http-429' })
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(now + 30 * 60 * 1000)
  expect(claudeOAuthRefreshStatus()[0]?.backoffLevel).toBe(3)
  expect(posts).toBe(3)

  now += 30 * 60 * 1000
  expect(await refresh()).toEqual({ outcome: 'failed', reason: 'http-429' })
  expect(claudeOAuthRefreshStatus()[0]?.backoffLevel).toBe(3)
  expect(claudeOAuthRefreshStatus()[0]?.nextRetryAt).toBe(now + 30 * 60 * 1000)
  expect(posts).toBe(4)
})

it('lets --force post during the shared backoff and still skips a live session', async () => {
  let posts = 0
  const blocked = harness({
    fetch: async () => {
      posts += 1
      return new Response('', { status: 429 })
    }
  })
  await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps: blocked.deps })
  expect(
    await refreshClaudeOAuthAccessToken({ accountId: 'acct', deps: blocked.deps, force: true })
  ).toEqual({ outcome: 'failed', reason: 'http-429' })
  expect(posts).toBe(2)
  expect(claudeOAuthRefreshStatus()[0]?.backoffLevel).toBe(1)

  const live = harness({ live: true })
  expect(
    await refreshClaudeOAuthAccessToken({ accountId: 'live', deps: live.deps, force: true })
  ).toEqual({ outcome: 'skipped', reason: 'live-session' })
  expect(live.calls).toHaveLength(0)
})

it('reserves three accounts per cycle and continues with the rest', () => {
  const accounts = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
    id,
    recentAt: 6 - index
  }))
  const plan = () => {
    beginClaudeOAuthRefreshCycle()
    return planClaudeUsageRefreshSlice({
      cycleId: claudeOAuthRefreshCycleId(),
      accounts,
      liveIds: [],
      now: NOW,
      mayRefresh: (id) => id !== 'b'
    })
  }
  expect(plan()).toEqual(['a', 'c', 'd'])
  expect(accounts.map((account) => claimClaudeUsageRefresh(account.id))).toEqual([
    true,
    false,
    true,
    true,
    false,
    false
  ])
  expect(plan()).toEqual(['e', 'f', 'a'])
  expect(plan()).toEqual(['c', 'd', 'e'])
})

it('numbers waiting accounts after the last account the cycle took', () => {
  const accounts = ['w', 'x', 'y', 'z'].map((id, index) => ({
    id,
    lastAuthenticatedAt: 4 - index
  }))
  beginClaudeOAuthRefreshCycle()
  expect(
    planClaudeUsageRefreshSlice({
      cycleId: claudeOAuthRefreshCycleId(),
      accounts: accounts.map((account) => ({
        id: account.id,
        recentAt: account.lastAuthenticatedAt
      })),
      liveIds: [],
      now: NOW,
      mayRefresh: () => true
    })
  ).toEqual(['w', 'x', 'y'])
  expect(claudeOAuthRefreshRows(accounts).map((row) => [row.accountId, row.queuePosition])).toEqual(
    [
      ['w', 2],
      ['x', 3],
      ['y', 4],
      ['z', 1]
    ]
  )
})
