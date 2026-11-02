import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as KeychainPassword from '../macos-keychain/generic-password'

const usage = vi.hoisted(() => vi.fn())
const keychain = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<string | null> => null)
}))

vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: usage }))
vi.mock('../macos-keychain/generic-password', async () => {
  const actual = await vi.importActual<typeof KeychainPassword>(
    '../macos-keychain/generic-password'
  )
  return {
    ...actual,
    readKeychainPassword: keychain.read,
    execSecurityCommand: async () => {
      throw new Error('usage refresh test must not write the keychain')
    }
  }
})

import {
  forgetClaudePaneAccount,
  recordClaudePaneAccount
} from '../claude-accounts/claude-pane-account-registry'
import { setMainHttpClient } from '../network/http-client'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { OAuthUsageError } from './claude-oauth-usage-error'
import {
  beginClaudeOAuthRefreshCycle,
  resetClaudeOAuthRefreshStateForTests
} from './claude-oauth-refresh'
import { planClaudeUsageRefreshSlice } from './claude-oauth-refresh-pacing'
import { claudeOAuthRefreshCycleId } from './claude-oauth-refresh-state'

const roots: string[] = []
const posts: string[] = []
let tokenMode: 'ok' | 'invalid' = 'ok'

function unauthorized(): Error {
  return new OAuthUsageError('Invalid OAuth token.', 401, true, null)
}

function homeFor(id: string): {
  home: string
  options: {
    authPreparation: {
      configDir: string
      envPatch: { CLAUDE_CONFIG_DIR: string }
      provenance: string
    }
  }
} {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-refresh-'))
  roots.push(home)
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 1,
        clientId: 'client-stored',
        scopes: ['user:profile'],
        organizationUuid: 'org-keep'
      },
      extraTop: 'keep-me'
    })
  )
  return {
    home,
    options: {
      authPreparation: {
        configDir: home,
        envPatch: { CLAUDE_CONFIG_DIR: home },
        provenance: `profile:${id}`
      }
    }
  }
}

beforeEach(() => {
  resetClaudeOAuthRefreshStateForTests()
  setMainHttpClient({
    fetch: async (url, init) => {
      posts.push(String(init?.body ?? ''))
      if (url !== 'https://platform.claude.com/v1/oauth/token') {
        throw new Error('unexpected endpoint')
      }
      if (tokenMode === 'invalid') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600
        }),
        { status: 200 }
      )
    },
    proxySession: () => null
  })
})

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  forgetClaudePaneAccount('pty-usage-refresh')
  resetClaudeOAuthRefreshStateForTests()
  setMainHttpClient(null)
  posts.splice(0)
  tokenMode = 'ok'
  usage.mockReset()
  keychain.read.mockReset()
  keychain.read.mockResolvedValue(null)
})

it('refreshes a 401 once and retries usage with the new access token', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const { home, options } = homeFor('acct')
  beginClaudeOAuthRefreshCycle()
  usage.mockImplementation(async (token: string) => {
    if (token === 'old-access') {
      throw unauthorized()
    }
    return {
      provider: 'claude',
      status: 'ok',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: null
    }
  })
  const before = Date.now()
  const result = await fetchActiveClaudeRateLimits(options)
  expect(result).toMatchObject({ status: 'ok', usageMetadata: { authProvenance: 'profile:acct' } })
  expect(usage.mock.calls.map((call) => call[0])).toEqual(['old-access', 'new-access'])
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0] ?? '{}')).toMatchObject({
    grant_type: 'refresh_token',
    client_id: 'client-stored'
  })
  const written = JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8'))
  expect(written.extraTop).toBe('keep-me')
  expect(written.claudeAiOauth.organizationUuid).toBe('org-keep')
  expect(written.claudeAiOauth.accessToken).toBe('new-access')
  expect(written.claudeAiOauth.refreshToken).toBe('new-refresh')
  expect(written.claudeAiOauth.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
  const logged = info.mock.calls.flat().join(' ')
  expect(logged).toContain('[claude-usage] refresh account=acct ok')
  expect(logged).not.toContain('old-refresh')
  expect(logged).not.toContain('new-access')
  expect(logged).not.toContain('new-refresh')
})

it('does not refresh a second time in the same usage cycle', async () => {
  const { options } = homeFor('cycle')
  beginClaudeOAuthRefreshCycle()
  usage.mockRejectedValue(unauthorized())
  await fetchActiveClaudeRateLimits(options)
  expect(posts).toHaveLength(1)
  await fetchActiveClaudeRateLimits(options)
  expect(posts).toHaveLength(1)
})

it('marks invalid_grant as lapsed and leaves the stored credentials in place', async () => {
  const { home, options } = homeFor('lapsed')
  tokenMode = 'invalid'
  beginClaudeOAuthRefreshCycle()
  usage.mockRejectedValue(unauthorized())
  expect(await fetchActiveClaudeRateLimits(options)).toMatchObject({
    status: 'error',
    error: 'Sign in again to use this account.',
    usageMetadata: { failureKind: 'lapsed', httpStatus: 401 }
  })
  expect(usage).toHaveBeenCalledTimes(1)
  const written = JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8'))
  expect(written.claudeAiOauth.accessToken).toBe('old-access')
  expect(written.claudeAiOauth.refreshToken).toBe('old-refresh')
  beginClaudeOAuthRefreshCycle()
  expect(await fetchActiveClaudeRateLimits(options)).toMatchObject({
    usageMetadata: { failureKind: 'lapsed' }
  })
  expect(posts).toHaveLength(1)
})

it('does not refresh an account whose own Claude pane is running', async () => {
  const { options } = homeFor('live')
  recordClaudePaneAccount({
    ptyId: 'pty-usage-refresh',
    paneKey: null,
    accountId: 'live',
    assignedAccountId: 'someone-else',
    configDir: null,
    launchedAt: 1,
    pinned: false,
    source: 'spawn'
  })
  beginClaudeOAuthRefreshCycle()
  usage.mockRejectedValue(unauthorized())
  expect(await fetchActiveClaudeRateLimits(options)).toMatchObject({
    usageMetadata: { failureKind: 'stale-token' }
  })
  expect(posts).toHaveLength(0)
  expect(usage).toHaveBeenCalledTimes(1)
})

it('leaves a 401 stale when this usage cycle did not reserve the account', async () => {
  const { options } = homeFor('capped')
  beginClaudeOAuthRefreshCycle()
  planClaudeUsageRefreshSlice({
    cycleId: claudeOAuthRefreshCycleId(),
    accounts: [
      { id: 'a', recentAt: 4 },
      { id: 'b', recentAt: 3 },
      { id: 'c', recentAt: 2 },
      { id: 'capped', recentAt: 1 }
    ],
    liveIds: [],
    now: Date.now(),
    mayRefresh: () => true
  })
  usage.mockRejectedValue(unauthorized())
  expect(await fetchActiveClaudeRateLimits(options)).toMatchObject({
    usageMetadata: { failureKind: 'stale-token' }
  })
  expect(posts).toHaveLength(0)
})
