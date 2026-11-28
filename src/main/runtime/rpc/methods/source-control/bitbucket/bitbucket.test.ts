import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { BitbucketConnectParams } from '../../../../../../shared/rpc-contract/source-control/bitbucket-params'
import { BITBUCKET_METHODS } from './bitbucket'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  status: vi.fn(),
  resetPreflight: vi.fn()
}))
vi.mock('../../../../../bitbucket/credential-connection', () => ({
  connectBitbucket: mocks.connect,
  disconnectBitbucket: mocks.disconnect,
  getBitbucketConnectionStatus: mocks.status
}))
vi.mock('../../../../../preflight/agent-detection', () => ({
  _resetPreflightCache: mocks.resetPreflight
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read no context.
const context = {} as unknown as RpcContext

function method(name: string) {
  return BITBUCKET_METHODS.find((entry) => entry.name === name)!
}

function callMethod(name: string, params: unknown): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: params match the method's schema.
  const handler = method(name).handler as (input: unknown, ctx: RpcContext) => Promise<unknown>
  return handler(params, context)
}

describe('bitbucket credential RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves the credential on this host and refreshes its preflight', async () => {
    mocks.connect.mockResolvedValue({ ok: true, account: 'dev' })
    const params = BitbucketConnectParams.parse({
      authMode: 'basic',
      email: 'dev@example.com',
      apiToken: 'secret',
      baseUrl: null
    })

    await expect(callMethod('bitbucket.connect', params)).resolves.toEqual({
      ok: true,
      account: 'dev'
    })
    expect(mocks.connect).toHaveBeenCalledWith(params)
    expect(mocks.resetPreflight).toHaveBeenCalledTimes(1)
  })

  it('keeps the preflight cache when Bitbucket rejects the credential', async () => {
    mocks.connect.mockResolvedValue({ ok: false, error: 'rejected', errorCode: 'rejected' })

    await callMethod('bitbucket.connect', { authMode: 'token', accessToken: 'x' })
    expect(mocks.resetPreflight).not.toHaveBeenCalled()
  })

  it('needs account-admin rights to write or remove the credential', () => {
    expect(method('bitbucket.connect').permission).toBe('accounts-admin')
    expect(method('bitbucket.disconnect').permission).toBe('accounts-admin')
  })

  it('rejects an unknown auth mode before touching the store', () => {
    expect(BitbucketConnectParams.safeParse({ authMode: 'oauth' }).success).toBe(false)
  })

  it('refuses a plain-http base URL that would send the secret in the clear', () => {
    const parse = (baseUrl: string | null) =>
      BitbucketConnectParams.safeParse({ authMode: 'token', accessToken: 'x', baseUrl }).success

    expect(parse('http://bitbucket.example.com/rest/api')).toBe(false)
    expect(parse('ftp://bitbucket.example.com')).toBe(false)
    expect(parse('not a url')).toBe(false)
    expect(parse('https://bitbucket.example.com/rest/api')).toBe(true)
    expect(parse('http://localhost:7990/rest/api')).toBe(true)
    expect(parse('')).toBe(true)
    expect(parse(null)).toBe(true)
  })
})
