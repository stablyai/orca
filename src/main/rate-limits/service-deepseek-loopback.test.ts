import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { rmSync } from 'node:fs'
import * as secureFile from '../../shared/secure-file'
import { setMainHttpClient } from '../network/http-client'
import { DeepSeekCredentials } from '../deepseek/deepseek-credentials'
import {
  deepSeekCredentialFixture,
  DEEPSEEK_FIXTURE_BALANCE,
  installDeepSeekTestSecretStore,
  SYNTHETIC_DEEPSEEK_KEY
} from '../deepseek/deepseek-test-fixture'
import { RateLimitService } from './service'
import { DEEPSEEK_BALANCE_URL } from './deepseek-fetcher'

vi.mock('./grok-auth', () => ({ readGrokAuthSession: () => ({ status: 'missing' }) }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: () => false }))
vi.mock('../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: () => false }))

describe('production DeepSeek service against a task-only loopback API', () => {
  let server: Server
  let fixture: ReturnType<typeof deepSeekCredentialFixture>
  let service: RateLimitService
  let status: number
  let payload: unknown
  let hold: boolean
  let held: ServerResponse | null
  let requests: {
    path: string | undefined
    method: string | undefined
    authorization: string | undefined
  }[]
  let port: number
  let dispatchedRequests: number

  beforeEach(async () => {
    installDeepSeekTestSecretStore()
    fixture = deepSeekCredentialFixture()
    fixture.credentials.save('fixture-host', SYNTHETIC_DEEPSEEK_KEY)
    service = new RateLimitService()
    service.setDeepSeekCredentials(fixture.credentials)
    status = 200
    payload = DEEPSEEK_FIXTURE_BALANCE
    hold = false
    held = null
    requests = []
    dispatchedRequests = 0
    server = createServer((request, response) => {
      requests.push({
        path: request.url,
        method: request.method,
        authorization: request.headers.authorization
      })
      if (hold) {
        held = response
        return
      }
      response.writeHead(status, {
        'content-type': 'application/json',
        ...(status === 302 ? { location: `http://127.0.0.1:${port}/must-not-follow` } : {})
      })
      response.end(JSON.stringify(payload))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Loopback did not bind TCP')
    }
    port = address.port
    setMainHttpClient({
      fetch: (url, options) => {
        expect(url).toBe(DEEPSEEK_BALANCE_URL)
        dispatchedRequests += 1
        return globalThis.fetch(`http://127.0.0.1:${port}/user/balance`, options)
      },
      proxySession: () => null
    })
  })
  afterEach(async () => {
    service.stop()
    setMainHttpClient(null)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(fixture.directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('executes the protected production credential/service/HTTP path and publishes only monetary data', async () => {
    const updates: unknown[] = []
    service.onStateChange((state) => updates.push(state))
    const state = await service.refreshDeepSeekBalance()
    expect(state.deepseek).toMatchObject({
      status: 'ok',
      balance: DEEPSEEK_FIXTURE_BALANCE,
      session: null,
      weekly: null,
      monthly: null
    })
    expect(requests).toEqual([
      { path: '/user/balance', method: 'GET', authorization: `Bearer ${SYNTHETIC_DEEPSEEK_KEY}` }
    ])
    expect(state.deepseekAccount).toEqual({
      supported: true,
      configured: true,
      ownerId: 'fixture-host',
      protection: 'sealed'
    })
    expect(JSON.stringify(updates)).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
  })

  it('keeps only a same-credential recent balance on HTTP failure and marks it stale', async () => {
    const first = await service.refreshDeepSeekBalance()
    status = 401
    payload = { error: SYNTHETIC_DEEPSEEK_KEY }
    const next = await service.refreshDeepSeekBalance()
    expect(next.deepseek).toMatchObject({
      status: 'error',
      balance: DEEPSEEK_FIXTURE_BALANCE,
      updatedAt: first.deepseek?.updatedAt
    })
    expect(JSON.stringify(next)).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
    service.removeDeepSeekApiKey('fixture-host')
    await service.refreshDeepSeekBalance()
    expect(service.getState().deepseek?.balance).toBeNull()
    expect(service.getState().deepseekAccount?.configured).toBe(false)
  })

  it('drops a response from a removed credential, including its stale balance', async () => {
    hold = true
    const pending = service.refreshDeepSeekBalance()
    await vi.waitFor(() => expect(held).not.toBeNull())
    service.removeDeepSeekApiKey('fixture-host')
    hold = false
    if (!held) {
      throw new Error('Expected an in-flight fixture response')
    }
    held.end(JSON.stringify(DEEPSEEK_FIXTURE_BALANCE))
    await pending
    await service.refreshDeepSeekBalance()
    expect(service.getState().deepseek?.balance).toBeNull()
    expect(service.getState().deepseekAccount?.configured).toBe(false)
  })

  it('detects external credential rotation before applying a completed request', async () => {
    hold = true
    const pending = service.refreshDeepSeekBalance()
    await vi.waitFor(() => expect(held).not.toBeNull())
    fixture.credentials.save('fixture-host', 'sk-fixture-replacement')
    hold = false
    if (!held) {
      throw new Error('Expected an in-flight fixture response')
    }
    held.end(JSON.stringify(DEEPSEEK_FIXTURE_BALANCE))
    await pending
    expect(service.getState().deepseek?.balance).toBeUndefined()
    expect(() =>
      service.setDeepSeekCredentials(new DeepSeekCredentials('other-owner', fixture.path))
    ).toThrow('immutable')
  })

  it('executes the actual 15-second timeout without inventing zero balance', async () => {
    hold = true
    const state = await service.refreshDeepSeekBalance()
    expect(state.deepseek).toMatchObject({
      status: 'error',
      balance: null,
      error: 'DeepSeek balance request timed out'
    })
    expect(requests).toHaveLength(1)
  }, 20_000)

  it('does not reuse the previous key’s balance after external rotation', async () => {
    await service.refreshDeepSeekBalance()
    fixture.credentials.save('fixture-host', 'sk-fixture-replacement')
    status = 401
    const state = await service.refreshDeepSeekBalance()
    expect(state.deepseek?.balance).toBeNull()
    expect(state.deepseek?.status).toBe('error')
  })

  it('aborts an explicit balance request when the host service stops', async () => {
    hold = true
    const pending = service.refreshDeepSeekBalance()
    await vi.waitFor(() => expect(held).not.toBeNull())
    service.stop()
    await pending
    expect(service.getState().deepseek?.balance).toBeUndefined()
  })

  it('cancels a saved-key follow-up when the host stops before the pending request settles', async () => {
    hold = true
    const read = vi.spyOn(fixture.credentials, 'read')
    const pending = service.refreshDeepSeekBalance()
    await vi.waitFor(() => expect(held).not.toBeNull())
    service.saveDeepSeekApiKey('fixture-host', 'sk-fixture-replacement')
    const updates: unknown[] = []
    service.onStateChange((state) => updates.push(state))
    service.stop()
    await pending
    await Promise.resolve()
    expect(dispatchedRequests).toBe(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(updates).toEqual([])
    expect(service.getState().deepseek).toBeNull()
  })

  it('polls the saved replacement when the host remains active', async () => {
    hold = true
    const pending = service.refreshDeepSeekBalance()
    await vi.waitFor(() => expect(held).not.toBeNull())
    service.saveDeepSeekApiKey('fixture-host', 'sk-fixture-replacement')
    payload = { ...DEEPSEEK_FIXTURE_BALANCE, is_available: false }
    hold = false
    if (!held) {
      throw new Error('Expected an in-flight fixture response')
    }
    held.end(JSON.stringify(DEEPSEEK_FIXTURE_BALANCE))
    await pending
    await vi.waitFor(() => expect(service.getState().deepseek?.balance).toEqual(payload))
    expect(dispatchedRequests).toBe(2)
    expect(requests[1]?.authorization).toBe('Bearer sk-fixture-replacement')
  })

  it('clears the old balance when a failed permission restriction already published the replacement', async () => {
    await service.refreshDeepSeekBalance()
    const revision = fixture.credentials.revision()
    const durableWrite = secureFile.writeSecureFile
    vi.spyOn(secureFile, 'writeSecureFile').mockImplementationOnce((...args) => {
      expect(durableWrite(...args)).toBe(true)
      return false
    })
    expect(() => service.saveDeepSeekApiKey('fixture-host', 'sk-fixture-replacement')).toThrow(
      'DeepSeek API key could not be saved in protected storage'
    )
    expect(fixture.credentials.revision()).not.toBe(revision)
    expect(service.getState().deepseek).toBeNull()
    expect(service.getState().deepseekAccount?.configured).toBe(true)
    expect(JSON.stringify(service.getState())).not.toContain('sk-fixture-replacement')
    await Promise.resolve()
    expect(dispatchedRequests).toBe(1)
  })

  it('refuses redirects at the real HTTP transport without forwarding a credential', async () => {
    status = 302
    const state = await service.refreshDeepSeekBalance()
    expect(state.deepseek?.status).toBe('error')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toBe('/user/balance')
  })

  it('does not make a local request for an unsupported host backend', async () => {
    const unsupported = new RateLimitService()
    const state = await unsupported.refreshDeepSeekBalance()
    expect(state.deepseekAccount).toMatchObject({
      supported: false,
      configured: false,
      ownerId: null
    })
    expect(state.deepseek).toMatchObject({ status: 'unavailable', balance: null })
    expect(requests).toHaveLength(0)
    unsupported.stop()
  })
})
