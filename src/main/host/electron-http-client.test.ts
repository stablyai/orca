import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type LoginCallback = (username?: string, password?: string) => void
type ProxyChallenge = { isProxy: boolean; host: string; port: number }

class FakeClientRequest extends Writable {
  readonly body: Buffer[] = []
  readonly headers = new Map<string, string>()
  readonly abort = vi.fn()
  ended = false

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.body.push(chunk)
    callback()
  }

  override _final(callback: () => void): void {
    this.ended = true
    callback()
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key, value)
  }

  challenge(authInfo: ProxyChallenge): LoginCallback {
    const callback = vi.fn<LoginCallback>()
    this.emit('login', authInfo, callback)
    return callback
  }

  respond(status: number, text: string | null): Readable {
    // null leaves the body stalled after headers.
    const stream = text === null ? new Readable({ read() {} }) : Readable.from([Buffer.from(text)])
    const response = Object.assign(stream, {
      statusCode: status,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] }
    })
    this.emit('response', response)
    return response
  }
}

const mocks = vi.hoisted(() => ({
  defaultSession: {
    resolveProxy: async (): Promise<string> => 'DIRECT',
    setProxy: async (): Promise<void> => {}
  },
  netFetch: vi.fn(),
  netRequest: vi.fn(),
  readiness: vi.fn<() => boolean | Promise<boolean>>(() => true)
}))

vi.mock('electron', () => ({
  net: { fetch: mocks.netFetch, request: mocks.netRequest },
  session: { defaultSession: mocks.defaultSession }
}))

vi.mock('../network/proxy-settings', () => ({
  getProxySessionApplicationReadiness: mocks.readiness
}))

import {
  resetElectronProxyCredentialsForTests,
  setElectronProxyCredentialsForSession
} from '../network/electron-proxy-credentials'
import { electronHttpClient } from './electron-http-client'

const PROXY = { host: 'proxy.corp', port: 8080, username: 'user', password: 'secret' }
let native: FakeClientRequest

// Wrapped so awaiting the request start does not also await its response.
async function startRequest(init?: RequestInit): Promise<{ pending: Promise<Response> }> {
  const pending = electronHttpClient.fetch('https://api.example.com/v1', init)
  await vi.waitFor(() => expect(mocks.netRequest).toHaveBeenCalled())
  return { pending }
}

beforeEach(() => {
  native = new FakeClientRequest()
  mocks.netRequest.mockReturnValue(native)
  mocks.netFetch.mockResolvedValue(new Response('direct'))
  mocks.readiness.mockReturnValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
  resetElectronProxyCredentialsForTests()
})

describe('electronHttpClient proxy authentication', () => {
  it('keeps Electron fetch when no proxy credentials are configured', async () => {
    const response = await electronHttpClient.fetch('https://api.example.com/v1')

    expect(await response.text()).toBe('direct')
    expect(mocks.netRequest).not.toHaveBeenCalled()
  })

  it('keeps Electron fetch for non-HTTP URLs', async () => {
    setElectronProxyCredentialsForSession(mocks.defaultSession, PROXY)

    await electronHttpClient.fetch('orca-asset://icon.png')

    expect(mocks.netFetch).toHaveBeenCalledWith('orca-asset://icon.png', undefined)
    expect(mocks.netRequest).not.toHaveBeenCalled()
  })

  it('answers the configured proxy challenge on a cold request', async () => {
    setElectronProxyCredentialsForSession(mocks.defaultSession, PROXY)
    const { pending } = await startRequest({ method: 'POST', body: 'payload', headers: { a: 'b' } })

    const login = native.challenge({ isProxy: true, host: 'PROXY.corp', port: 8080 })
    await vi.waitFor(() => expect(native.ended).toBe(true))
    native.respond(200, 'ok')
    const response = await pending

    expect(login).toHaveBeenCalledWith('user', 'secret')
    expect(mocks.netRequest).toHaveBeenCalledWith(
      expect.objectContaining({ session: mocks.defaultSession, method: 'POST' })
    )
    expect(native.headers.get('a')).toBe('b')
    expect(Buffer.concat(native.body).toString()).toBe('payload')
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2')
    expect(await response.text()).toBe('ok')
    expect(mocks.netFetch).not.toHaveBeenCalled()
  })

  it('cancels unrelated, origin, and repeated challenges', async () => {
    setElectronProxyCredentialsForSession(mocks.defaultSession, PROXY)
    await startRequest()

    expect(native.challenge({ isProxy: true, host: 'other', port: 8080 })).toHaveBeenCalledWith()

    native = new FakeClientRequest()
    mocks.netRequest.mockReturnValue(native)
    void electronHttpClient.fetch('https://api.example.com/v1')
    await vi.waitFor(() => expect(mocks.netRequest).toHaveBeenCalledTimes(2))
    expect(
      native.challenge({ isProxy: false, host: 'proxy.corp', port: 8080 })
    ).toHaveBeenCalledWith()

    native = new FakeClientRequest()
    mocks.netRequest.mockReturnValue(native)
    void electronHttpClient.fetch('https://api.example.com/v1')
    await vi.waitFor(() => expect(mocks.netRequest).toHaveBeenCalledTimes(3))
    const challenge = { isProxy: true, host: 'proxy.corp', port: 8080 }
    expect(native.challenge(challenge)).toHaveBeenCalledWith('user', 'secret')
    expect(native.challenge(challenge)).toHaveBeenCalledWith()
  })

  it('waits for a pending proxy policy to install its credentials', async () => {
    let settle: (ready: boolean) => void = () => {}
    mocks.readiness.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const pending = electronHttpClient.fetch('https://api.example.com/v1')

    setElectronProxyCredentialsForSession(mocks.defaultSession, PROXY)
    settle(true)
    await vi.waitFor(() => expect(mocks.netRequest).toHaveBeenCalled())
    native.respond(204, '')

    expect((await pending).body).toBeNull()
    expect(mocks.netFetch).not.toHaveBeenCalled()
  })

  it('rejects with the caller abort reason and aborts the native request', async () => {
    setElectronProxyCredentialsForSession(mocks.defaultSession, PROXY)
    const controller = new AbortController()
    const { pending } = await startRequest({ signal: controller.signal })

    const reason = new Error('stop')
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(native.abort).toHaveBeenCalled()
  })

  it('cancels a stalled response body without waiting for more data', async () => {
    setElectronProxyCredentialsForSession(mocks.defaultSession, PROXY)
    const { pending } = await startRequest()
    const stalled = native.respond(503, null)
    const response = await pending

    await response.body?.cancel()

    expect(stalled.destroyed).toBe(true)
  })
})
