import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { CODEX_RESET_HANDLERS } from './codex-reset'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import { ConsumeCodexResetCreditParams } from '../../shared/rpc-contract/accounts-params'

const account = {
  id: 'account-1',
  email: 'test@example.invalid',
  updatedAt: 100,
  createdAt: 1,
  lastAuthenticatedAt: 100
}
const target = { runtime: 'host', wslDistro: null } as const
const limits = {
  provider: 'codex',
  status: 'ok',
  error: null,
  updatedAt: 200,
  session: { usedPercent: 100, windowMinutes: 300, resetsAt: 1000, resetDescription: null },
  weekly: null,
  rateLimitResetCredits: { availableCount: 2 }
} as const

function snapshot() {
  return {
    codex: {
      accounts: [account],
      activeAccountId: account.id,
      activeAccountIdsByRuntime: { host: account.id, wsl: {} }
    },
    rateLimits: { codexTarget: target, codex: limits }
  }
}

function savedRequest() {
  return {
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    expectedScope: buildCodexResetCreditExpectedScope({ target, account, limits })
  }
}

function envelope(result: unknown) {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'test-runtime' } } as const
}

describe('Codex reset CLI', () => {
  let cwd: string
  let ctx: HandlerContext
  let call: MockInstance<RuntimeClient['call']>
  const handler = CODEX_RESET_HANDLERS['account reset-codex-limits']

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orca-reset-cli-test-'))
    const client = new RuntimeClient(cwd, 1000, null, null)
    call = vi.spyOn(client, 'call').mockImplementation(async (method) => {
      if (method === 'status.get') {
        return envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] })
      }
      if (method === 'accounts.list') {
        return envelope(snapshot())
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })
    ctx = { client, cwd, json: true, flags: new Map() }
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(cwd, { recursive: true, force: true })
  })

  function preview() {
    ctx.flags = new Map([
      ['account', account.id],
      ['out', 'attempt.json']
    ])
    return handler(ctx)
  }

  function confirm() {
    ctx.flags = new Map<string, string | boolean>([
      ['request-file', 'attempt.json'],
      ['confirm', true]
    ])
    return handler(ctx)
  }

  function writeRequest(value: unknown = savedRequest()) {
    writeFileSync(join(cwd, 'attempt.json'), JSON.stringify(value))
  }

  it('saves a validated scope and unique key without invoking the reset RPC', async () => {
    await preview()
    const request = ConsumeCodexResetCreditParams.parse(
      JSON.parse(readFileSync(join(cwd, 'attempt.json'), 'utf8'))
    )
    expect(request.expectedScope.accountId).toBe(account.id)
    expect(request.expectedScope.target).toEqual(target)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get', 'accounts.list'])
    expect(call).toHaveBeenLastCalledWith('accounts.list', { refreshUsage: false })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('test@example.invalid'))
  })

  it('does not overwrite an earlier attempt', async () => {
    writeRequest()
    await expect(preview()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(JSON.parse(readFileSync(join(cwd, 'attempt.json'), 'utf8'))).toEqual(savedRequest())
    expect(call.mock.calls.some(([method]) => method === 'accounts.consumeCodexResetCredit')).toBe(
      false
    )
  })

  it('refuses an account other than the selected account without switching it', async () => {
    ctx.flags = new Map([
      ['account', 'different-account'],
      ['out', 'attempt.json']
    ])
    await expect(handler(ctx)).rejects.toThrow('not selected')
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get', 'accounts.list'])
  })

  it('rejects missing or unavailable reset-credit data', async () => {
    const state = snapshot()
    call
      .mockResolvedValueOnce(envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] }))
      .mockResolvedValueOnce(
        envelope({ ...state, rateLimits: { ...state.rateLimits, codex: null } })
      )
    await expect(preview()).rejects.toMatchObject({ code: 'reset_unavailable' })
  })

  it('preserves the exact WSL account and distro scope', async () => {
    const wslAccount = { ...account, managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }
    call
      .mockResolvedValueOnce(envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] }))
      .mockResolvedValueOnce(
        envelope({
          codex: {
            accounts: [wslAccount],
            activeAccountId: 'host-account',
            activeAccountIdsByRuntime: { host: 'host-account', wsl: { Ubuntu: account.id } }
          },
          rateLimits: { codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }, codex: limits }
        })
      )
    await preview()
    const request = ConsumeCodexResetCreditParams.parse(
      JSON.parse(readFileSync(join(cwd, 'attempt.json'), 'utf8'))
    )
    expect(request.expectedScope.target).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it.each(['environment', 'pairing-code'])('rejects --%s before connecting', async (flag) => {
    ctx.flags.set(flag, 'remote')
    await expect(handler(ctx)).rejects.toThrow('does not retarget')
    expect(call).not.toHaveBeenCalled()
  })

  const invalidFlags: { entries: [string, string | boolean][] }[] = [
    { entries: [] },
    { entries: [['confirm', true]] },
    { entries: [['request-file', 'attempt.json']] },
    {
      entries: [
        ['request-file', 'attempt.json'],
        ['confirm', 'false']
      ]
    },
    {
      entries: [
        ['request-file', 'attempt.json'],
        ['confirm', true],
        ['account', account.id]
      ]
    },
    {
      entries: [
        ['account', true],
        ['out', 'attempt.json']
      ]
    }
  ]
  it.each(invalidFlags)(
    'rejects incomplete or conflicting authorization flags $entries',
    async ({ entries }) => {
      ctx.flags = new Map<string, string | boolean>(entries)
      await expect(handler(ctx)).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('refuses an older runtime before preparing a request', async () => {
    call.mockResolvedValueOnce(envelope({ capabilities: [] }))
    await expect(preview()).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    {},
    { ...savedRequest(), idempotencyKey: 'invalid' },
    { ...savedRequest(), unexpected: true }
  ])('refuses invalid saved requests before RPC %j', async (request) => {
    writeRequest(request)
    await expect(confirm()).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it.each(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'])(
    'preserves outcome %s',
    async (outcome) => {
      writeRequest()
      call
        .mockResolvedValueOnce(envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] }))
        .mockResolvedValueOnce(
          envelope({ outcome, scope: savedRequest().expectedScope, snapshot: snapshot() })
        )
      await confirm()
      expect(call).toHaveBeenLastCalledWith('accounts.consumeCodexResetCredit', savedRequest())
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`"outcome": "${outcome}"`))
      expect(call.mock.calls.some(([method]) => method === 'accounts.list')).toBe(false)
    }
  )

  it('retains identical params when retrying a lost response', async () => {
    writeRequest()
    call
      .mockResolvedValueOnce(envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] }))
      .mockRejectedValueOnce(new RuntimeClientError('timeout', 'Response lost'))
    await expect(confirm()).rejects.toMatchObject({
      code: 'timeout',
      data: { idempotencyKey: savedRequest().idempotencyKey }
    })
    call
      .mockResolvedValueOnce(envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] }))
      .mockResolvedValueOnce(
        envelope({ outcome: 'alreadyRedeemed', scope: savedRequest().expectedScope })
      )
    await confirm()
    const attempts = call.mock.calls.filter(
      ([method]) => method === 'accounts.consumeCodexResetCredit'
    )
    expect(attempts).toHaveLength(2)
    expect(attempts[0][1]).toEqual(attempts[1][1])
    expect(JSON.parse(readFileSync(join(cwd, 'attempt.json'), 'utf8'))).toEqual(savedRequest())
  })

  it('surfaces a pre-provider scope rejection as an error rather than success', async () => {
    writeRequest()
    call
      .mockResolvedValueOnce(envelope({ capabilities: [CODEX_RESET_CREDIT_RUNTIME_CAPABILITY] }))
      .mockResolvedValueOnce(
        envelope({
          status: 'rejectedBeforeProvider',
          retryDisposition: 'discardAttempt',
          reason: 'accountChanged',
          scope: savedRequest().expectedScope
        })
      )
    await expect(confirm()).rejects.toMatchObject({ code: 'reset_scope_changed' })
  })
})
