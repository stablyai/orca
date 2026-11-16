import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../network/http-client'
import { ClaudeResetCreditClient } from './claude-reset-credit-client'
import { ClaudeResetCreditLedger } from './claude-reset-credit-ledger'
import { invalidateClaudeOAuthVersion } from '../../rate-limits/providers/claude/claude-oauth-request'
import type { ClaudeResetCreditRequest } from '../../../shared/agent-accounts/claude/claude-reset-credit-types'

vi.mock('../../rate-limits/providers/claude/claude-oauth-credentials', () => ({
  readClaudeOAuthCredentials: async () => ({ token: 'test-access-token' }),
  resolveClaudeOAuthCredentialReadOptions: () => ({})
}))
vi.mock('../../claude/cli-capabilities/claude-hook-event-versions', () => ({
  probeClaudeCliVersion: async () => '2.1.333'
}))
vi.mock('../../codex-cli/command', () => ({ resolveClaudeCommand: () => 'claude' }))
vi.mock('../../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: async () => {}
}))

const identity = {
  email: 'reset@example.com',
  accountUuid: '4b31b3a5-867b-403a-8834-d8900820c18c',
  organizationUuid: '7bb9b6c6-ce31-4e30-8dd6-df4b23b4c5e8'
}
const account = { accountId: 'managed', target: { runtime: 'host' as const, wslDistro: null } }
const auth = { configDir: '/claude-profile', envPatch: {}, provenance: 'profile:managed' }
const request: ClaudeResetCreditRequest = {
  account,
  identity,
  grantId: 'monthly-reset',
  expectedResetsLeft: 2,
  expectedClears: ['five_hour'],
  requestId: '97a2cb6b-6c8d-42ac-8fdc-c03597ad6d31'
}
const grant = {
  id: 'monthly-reset',
  label: 'Monthly reset',
  resets_total: 2,
  resets_left: 2,
  starts_at: '2020-01-01T00:00:00Z',
  ends_at: '2099-01-01T00:00:00Z',
  clears: ['five_hour'],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  blocking: []
}
const credits = {
  eligible: true,
  ineligible_reason: null,
  at_limit: false,
  next_grant_id: 'monthly-reset',
  cooldown_until: null,
  grants: [grant]
}
let directory: string
let client: ClaudeResetCreditClient
let usage: unknown
let post: (body: string) => Promise<Response>
let submitted: string[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-reset-'))
  client = new ClaudeResetCreditClient(new ClaudeResetCreditLedger(directory))
  invalidateClaudeOAuthVersion()
  usage = { cedar_ember: credits }
  submitted = []
  post = async () => {
    throw new Error('Unexpected reset submission')
  }
  setMainHttpClient({
    proxySession: () => null,
    fetch: async (url, init) => {
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-access-token',
        'User-Agent': 'claude-cli/2.1.333 (external, cli)',
        'x-app': 'cli',
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json'
      })
      if (init?.method === 'POST') {
        expect(url).toBe(
          'https://api.anthropic.com/api/organizations/7bb9b6c6-ce31-4e30-8dd6-df4b23b4c5e8/reset_rate_limits'
        )
        const body = String(init.body)
        submitted.push(body)
        return post(body)
      }
      if (url.endsWith('/profile')) {
        return Response.json({
          account: { email: identity.email, uuid: identity.accountUuid },
          organization: { uuid: identity.organizationUuid }
        })
      }
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1')
      return Response.json(usage)
    }
  })
})

afterEach(async () => {
  setMainHttpClient(null)
  await rm(directory, { recursive: true, force: true })
})

describe('Claude reset-card operations', () => {
  it('records before spending, verifies the balance, and replays after restart without another POST', async () => {
    post = async (body) => {
      expect(JSON.parse(body)).toEqual({
        program: 'cedar_ember',
        grant_id: 'monthly-reset',
        request_id: '97a2cb6b-6c8d-42ac-8fdc-c03597ad6d31'
      })
      const receipt = await readFile(join(directory, `${request.requestId}.json`), 'utf8')
      expect(JSON.parse(receipt).result.outcome).toBe('unknown')
      expect(receipt).not.toContain('test-access-token')
      usage = { cedar_ember: { ...credits, grants: [{ ...grant, resets_left: 1 }] } }
      return Response.json({ result: 'reset', grant_id: 'monthly-reset', cleared: ['five_hour'] })
    }
    const result = await client.consume(request, auth)
    expect(result).toMatchObject({
      outcome: 'reset',
      cleared: ['five_hour'],
      verified: true,
      credits: { grants: [{ resetsLeft: 1 }] }
    })
    const restarted = new ClaudeResetCreditClient(new ClaudeResetCreditLedger(directory))
    expect(await restarted.consume(request, auth)).toMatchObject({
      outcome: 'reset',
      verified: true
    })
    expect(submitted).toHaveLength(1)
  })

  it('keeps an uncertain attempt fenced across restarts and other operation IDs', async () => {
    post = async () => {
      throw new Error('Connection lost after submission')
    }
    expect(await client.consume(request, auth)).toMatchObject({
      outcome: 'unknown',
      verified: false
    })
    const restarted = new ClaudeResetCreditClient(new ClaudeResetCreditLedger(directory))
    expect(await restarted.query(account, auth)).toMatchObject({
      pendingRequestId: '97a2cb6b-6c8d-42ac-8fdc-c03597ad6d31'
    })
    await expect(
      restarted.consume({ ...request, requestId: '01b80efe-29f6-4a3b-9f5d-a10ce04307c0' }, auth)
    ).rejects.toThrow('still awaiting confirmation')
    expect(submitted).toHaveLength(1)
  })

  it('does not treat HTTP 200 with an indeterminate provider result as success', async () => {
    post = async () => Response.json({ result: 'reset', reason: 'reset_unconfirmed' })
    expect(await client.consume(request, auth)).toMatchObject({
      outcome: 'unknown',
      verified: false
    })
    expect(await client.query(account, auth)).toMatchObject({ pendingRequestId: request.requestId })
  })

  it('verifies a reported reset on a later read without spending again', async () => {
    post = async () => {
      usage = {}
      return Response.json({ result: 'reset', grant_id: 'monthly-reset', cleared: ['five_hour'] })
    }
    expect(await client.consume(request, auth)).toMatchObject({ outcome: 'reset', verified: false })
    expect(await client.query(account, auth)).toMatchObject({ pendingRequestId: request.requestId })
    usage = { cedar_ember: { ...credits, grants: [{ ...grant, resets_left: 1 }] } }
    const restarted = new ClaudeResetCreditClient(new ClaudeResetCreditLedger(directory))
    expect(await restarted.query(account, auth, undefined, request.requestId)).toMatchObject({
      pendingRequestId: null,
      previousResult: { outcome: 'reset', verified: true }
    })
    expect(submitted).toHaveLength(1)
  })

  it('reports missing or malformed grant data as unknown', async () => {
    usage = { five_hour: { utilization: 50 } }
    expect((await client.query(account, auth)).credits).toBeNull()
    usage = { cedar_ember: { ...credits, grants: [{ ...grant, resets_left: '2' }] } }
    expect((await client.query(account, auth)).credits).toBeNull()
  })

  it('refuses a confirmation for another account before spending', async () => {
    await expect(
      client.consume(
        { ...request, identity: { ...identity, email: 'different@example.com' } },
        auth
      )
    ).rejects.toThrow('account or organization changed')
    expect(submitted).toEqual([])
  })

  it.each([
    { name: 'another next grant', patch: { next_grant_id: 'another-reset' } },
    { name: 'a changed reset scope', patch: { grants: [{ ...grant, clears: ['seven_day'] }] } },
    { name: 'a changed remaining balance', patch: { grants: [{ ...grant, resets_left: 1 }] } },
    { name: 'a future cooldown', patch: { cooldown_until: '2099-01-01T00:00:00Z' } },
    {
      name: 'a grant requiring a limit by default',
      patch: { grants: [{ ...grant, use_requires_limit: undefined }] }
    },
    { name: 'a blocked window', patch: { grants: [{ ...grant, blocking: ['seven_day'] }] } },
    { name: 'an exhausted grant', patch: { grants: [{ ...grant, resets_left: 0 }] } }
  ])('rechecks $name before spending', async ({ patch }) => {
    usage = { cedar_ember: { ...credits, ...patch } }
    await expect(client.consume(request, auth)).rejects.toThrow('no longer available')
    expect(submitted).toEqual([])
  })
})
