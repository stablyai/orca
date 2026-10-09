import type { ClientRequestConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeHttpRequest, deferred } from './electron-http-request.fixture'

const { defaultSessionMock, netFetchMock, netRequestMock } = vi.hoisted(() => ({
  defaultSessionMock: {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {})
  },
  netFetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  netRequestMock: vi.fn<(options: ClientRequestConstructorOptions) => NativeHttpRequest>()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock },
  session: { defaultSession: defaultSessionMock }
}))

import { electronHttpClient } from './electron-http-client'
import {
  applyProxySettingsToSession,
  resetProxyApplicationForTests,
  retireProxySessionApplication,
  setDefaultProxySessionResolver
} from '../network/proxy-settings'

const requests: NativeHttpRequest[] = []
const proxyUrl = 'http://fixture-user:fixture-secret@proxy.example:8080'

async function nextRequest(index = 0): Promise<NativeHttpRequest> {
  await vi.waitFor(() => expect(requests.length).toBeGreaterThan(index), { timeout: 1_000 })
  const request = requests[index]
  if (!request) {
    throw new Error('Expected native request')
  }
  return request
}

async function configureProxy(): Promise<void> {
  await applyProxySettingsToSession(defaultSessionMock, { httpProxyUrl: proxyUrl }, { env: {} })
}

describe('electronHttpClient configured proxy authentication', () => {
  beforeEach(() => {
    requests.length = 0
    vi.resetAllMocks()
    resetProxyApplicationForTests()
    setDefaultProxySessionResolver(() => defaultSessionMock)
    defaultSessionMock.resolveProxy.mockResolvedValue('DIRECT')
    defaultSessionMock.setProxy.mockResolvedValue()
    defaultSessionMock.closeAllConnections.mockResolvedValue()
    netFetchMock.mockResolvedValue(new Response('native fetch'))
    netRequestMock.mockImplementation((options) => {
      const request = new NativeHttpRequest(options)
      requests.push(request)
      return request
    })
  })

  afterEach(() => {
    for (const request of requests) {
      request.dispose()
    }
    setDefaultProxySessionResolver(null)
  })

  it('keeps net.fetch and the caller options for sessions without configured credentials', async () => {
    const init: RequestInit = { headers: { Authorization: 'Bearer synthetic' }, cache: 'no-store' }
    const response = await electronHttpClient.fetch('https://origin.example/path', init)
    expect(await response.text()).toBe('native fetch')
    expect(netFetchMock).toHaveBeenCalledWith('https://origin.example/path', init)
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('waits for proxy application before choosing the authenticated request path', async () => {
    const write = deferred()
    defaultSessionMock.setProxy.mockImplementationOnce(() => write.promise)
    const application = applyProxySettingsToSession(
      defaultSessionMock,
      { httpProxyUrl: proxyUrl },
      { env: {} }
    )
    const pending = electronHttpClient.fetch('https://origin.example/path')
    await vi.waitFor(() => expect(defaultSessionMock.setProxy).toHaveBeenCalledOnce())
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
    write.finish()
    await application
    const request = await nextRequest()
    request.respond().finish()
    await expect(pending).resolves.toBeInstanceOf(Response)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('answers the matching proxy challenge using only configured session credentials', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'PROXY.EXAMPLE', port: 8080 }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith('fixture-user', 'fixture-secret')
    request.respond().finish()
    await expect(pending).resolves.toBeInstanceOf(Response)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('preserves custom protocol dispatch even when the session has proxy credentials', async () => {
    await configureProxy()
    const init: RequestInit = { cache: 'no-store' }
    await electronHttpClient.fetch('orca-media://fixture/document', init)
    expect(netFetchMock).toHaveBeenCalledWith('orca-media://fixture/document', init)
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('normalizes accepted HTTP URL whitespace before authenticated dispatch', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('  https://origin.example/path  ')
    const request = await nextRequest()
    expect(request.options.url).toBe('https://origin.example/path')
    request.respond().finish()
    await pending
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('preserves native fetch handling for an invalid URL', async () => {
    await configureProxy()
    const init: RequestInit = { cache: 'no-store' }
    await electronHttpClient.fetch('invalid-url', init)
    expect(netFetchMock).toHaveBeenCalledWith('invalid-url', init)
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('fails closed after a proxy application error', async () => {
    defaultSessionMock.setProxy.mockRejectedValue(new Error('Synthetic proxy apply failure'))
    await expect(configureProxy()).rejects.toThrow('Synthetic proxy apply failure')
    await expect(electronHttpClient.fetch('https://origin.example/path')).rejects.toThrow()
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('fails closed after the selected proxy session is retired', async () => {
    await configureProxy()
    await retireProxySessionApplication(defaultSessionMock)
    await expect(electronHttpClient.fetch('https://origin.example/path')).rejects.toThrow()
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('aborts a proxy readiness wait without starting a request after it settles', async () => {
    const write = deferred()
    defaultSessionMock.setProxy.mockImplementationOnce(() => write.promise)
    const application = applyProxySettingsToSession(
      defaultSessionMock,
      { httpProxyUrl: 'http://next-user:next-secret@proxy.example:8080' },
      { env: {} }
    )
    const controller = new AbortController()
    const pending = electronHttpClient.fetch('https://origin.example/path', {
      signal: controller.signal
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(defaultSessionMock.setProxy).toHaveBeenCalledOnce())
    controller.abort()
    await rejection
    write.finish()
    await application
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('does not start either native path for a pre-aborted request', async () => {
    await configureProxy()
    const controller = new AbortController()
    controller.abort()
    await expect(
      electronHttpClient.fetch('https://origin.example/path', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it.each(['synthetic-abort-reason', { fixture: 'synthetic-abort-reason' }])(
    'preserves an arbitrary pre-abort reason by identity: %j',
    async (reason) => {
      await configureProxy()
      const controller = new AbortController()
      controller.abort(reason)
      await expect(
        electronHttpClient.fetch('https://origin.example/path', { signal: controller.signal })
      ).rejects.toBe(reason)
      expect(netFetchMock).not.toHaveBeenCalled()
      expect(netRequestMock).not.toHaveBeenCalled()
    }
  )

  it.each(['synthetic-abort-reason', { fixture: 'synthetic-abort-reason' }])(
    'preserves an arbitrary abort reason while waiting for proxy readiness: %j',
    async (reason) => {
      const write = deferred()
      defaultSessionMock.setProxy.mockImplementationOnce(() => write.promise)
      const application = configureProxy()
      const controller = new AbortController()
      const pending = electronHttpClient.fetch('https://origin.example/path', {
        signal: controller.signal
      })
      const rejection = expect(pending).rejects.toBe(reason)
      await vi.waitFor(() => expect(defaultSessionMock.setProxy).toHaveBeenCalledOnce())
      controller.abort(reason)
      await rejection
      write.finish()
      await application
      expect(netFetchMock).not.toHaveBeenCalled()
      expect(netRequestMock).not.toHaveBeenCalled()
    }
  )

  it('uses the native Fetch DOMException for a null pre-abort reason', async () => {
    await configureProxy()
    const controller = new AbortController()
    controller.abort(null)
    const pending = electronHttpClient.fetch('https://origin.example/path', {
      signal: controller.signal
    })
    await expect(pending).rejects.toBeInstanceOf(DOMException)
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it('uses the native Fetch DOMException for a null abort during proxy readiness', async () => {
    const write = deferred()
    defaultSessionMock.setProxy.mockImplementationOnce(() => write.promise)
    const application = configureProxy()
    const controller = new AbortController()
    const pending = electronHttpClient.fetch('https://origin.example/path', {
      signal: controller.signal
    })
    const rejection = expect(pending).rejects.toBeInstanceOf(DOMException)
    await vi.waitFor(() => expect(defaultSessionMock.setProxy).toHaveBeenCalledOnce())
    controller.abort(null)
    await rejection
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted.'
    })
    write.finish()
    await application
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(netRequestMock).not.toHaveBeenCalled()
  })

  it.each([
    { isProxy: false, host: 'proxy.example', port: 8080 },
    { isProxy: true, host: 'other.example', port: 8080 },
    { isProxy: true, host: 'proxy.example', port: 3128 }
  ])('declines unrelated authentication challenges without credentials: %j', async (authInfo) => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    const callback = vi.fn()
    request.emit('login', authInfo, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith()
    expect(request.getHeader('proxy-authorization')).toBeUndefined()
    request.respond(407).finish()
    expect((await pending).status).toBe(407)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('declines a repeated proxy challenge after configured credentials were rejected', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    const authInfo = { isProxy: true, host: 'proxy.example', port: 8080 }
    const first = vi.fn()
    const repeated = vi.fn()
    request.emit('login', authInfo, first)
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
    request.emit('login', authInfo, repeated)
    await vi.waitFor(() => expect(repeated).toHaveBeenCalledOnce())
    expect(first).toHaveBeenCalledWith('fixture-user', 'fixture-secret')
    expect(repeated).toHaveBeenCalledWith()
    request.respond(407).finish()
    expect((await pending).status).toBe(407)
  })

  it('waits for the newest proxy transition before answering an in-flight challenge', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    const write = deferred()
    defaultSessionMock.setProxy.mockImplementationOnce(() => write.promise)
    const application = applyProxySettingsToSession(
      defaultSessionMock,
      { httpProxyUrl: 'http://next-user:next-secret@proxy.example:8080' },
      { env: {} }
    )
    await vi.waitFor(() => expect(defaultSessionMock.setProxy).toHaveBeenCalledTimes(2))
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    expect(callback).not.toHaveBeenCalled()
    write.finish()
    await application
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith('next-user', 'next-secret')
    request.respond().finish()
    await pending
  })

  it('declines an in-flight challenge when the proxy session is retired', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    await retireProxySessionApplication(defaultSessionMock)
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith()
    request.respond(407).finish()
    expect((await pending).status).toBe(407)
  })

  it('answers a pending challenge once without credentials after caller abort', async () => {
    await configureProxy()
    const controller = new AbortController()
    const pending = electronHttpClient.fetch('https://origin.example/path', {
      signal: controller.signal
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const request = await nextRequest()
    const write = deferred()
    defaultSessionMock.setProxy.mockImplementationOnce(() => write.promise)
    const application = applyProxySettingsToSession(
      defaultSessionMock,
      { httpProxyUrl: 'http://next-user:next-secret@proxy.example:8080' },
      { env: {} }
    )
    await vi.waitFor(() => expect(defaultSessionMock.setProxy).toHaveBeenCalledTimes(2))
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    controller.abort()
    await rejection
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith()
    write.finish()
    await application
    expect(callback).toHaveBeenCalledOnce()
    expect(request.abort).toHaveBeenCalledOnce()
  })

  it('declines a challenge after the newest proxy application fails', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    defaultSessionMock.setProxy.mockRejectedValue(new Error('Synthetic proxy update failure'))
    const application = applyProxySettingsToSession(
      defaultSessionMock,
      { httpProxyUrl: 'http://next-user:next-secret@proxy.example:8080' },
      { env: {} }
    )
    const rejection = expect(application).rejects.toThrow('Synthetic proxy update failure')
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    await rejection
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith()
    request.respond(407).finish()
    expect((await pending).status).toBe(407)
  })

  it('rejects a native authentication callback error without invoking it again', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const rejection = expect(pending).rejects.toThrow('Synthetic callback error')
    const request = await nextRequest()
    const callback = vi.fn(() => {
      throw new Error('Synthetic callback error')
    })
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    await rejection
    expect(callback).toHaveBeenCalledOnce()
    expect(request.abort).toHaveBeenCalledOnce()
  })

  it('normalizes fetch options without changing manual account headers or request payload', async () => {
    await configureProxy()
    const init: RequestInit = {
      method: 'post',
      headers: new Headers({
        Authorization: 'Bearer synthetic-account',
        'X-Account-Id': 'synthetic-id'
      }),
      body: JSON.stringify({ idempotency_key: 'synthetic-redemption' }),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }
    const pending = electronHttpClient.fetch('https://origin.example/credits', init)
    const request = await nextRequest()
    await vi.waitFor(() => expect(request.writableFinished).toBe(true))
    expect(request.options).toMatchObject({
      url: 'https://origin.example/credits',
      method: 'POST',
      session: defaultSessionMock,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    })
    expect(request.options.useSessionCookies).toBeUndefined()
    expect(request.getHeader('authorization')).toBe('Bearer synthetic-account')
    expect(request.getHeader('x-account-id')).toBe('synthetic-id')
    expect(Buffer.concat(request.chunks).toString()).toBe(init.body)
    expect(request.chunkedEncoding).toBe(false)
    request.respond().finish()
    await pending
  })

  it.each([
    [{}, 'include', undefined, undefined],
    [{ credentials: 'omit' }, 'omit', undefined, undefined],
    [
      { headers: { Origin: 'https://caller.example' } },
      'same-origin',
      'https://caller.example',
      'cors'
    ],
    [{ mode: 'no-cors' }, 'include', undefined, 'no-cors']
  ] satisfies [RequestInit, string, string | undefined, string | undefined][])(
    'preserves Chromium fetch cookie and origin policy for %j',
    async (init, credentials, origin, fetchMode) => {
      await configureProxy()
      const pending = electronHttpClient.fetch('https://origin.example/path', init)
      const request = await nextRequest()
      expect(request.options.credentials).toBe(credentials)
      expect(request.options.origin).toBe(origin)
      expect(request.options.redirect).toBe('follow')
      expect(request.options.useSessionCookies).toBeUndefined()
      expect(request.getHeader('sec-fetch-mode')).toBe(fetchMode)
      request.respond().finish()
      await pending
    }
  )

  it('returns real response headers before the streamed body is complete', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const request = await nextRequest()
    const incoming = request.respond(200, {
      'content-type': 'application/json',
      'x-origin': 'synthetic',
      'set-cookie': ['a=1', 'b=2']
    })
    const response = await pending
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.headers.get('x-origin')).toBe('synthetic')
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2')
    expect(response.body).not.toBeNull()
    incoming.send('{"ok":')
    incoming.send('true}')
    incoming.finish()
    expect(await response.json()).toEqual({ ok: true })
    expect(request.abort).not.toHaveBeenCalled()
  })

  it('bounds unread response buffering and resumes production as the caller reads', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/large')
    const request = await nextRequest()
    const incoming = request.respond()
    incoming.generate(256, 16 * 1024)
    const response = await pending
    await vi.waitFor(() => expect(incoming.producedBytes).toBeGreaterThan(0))
    expect(incoming.producedBytes).toBeLessThanOrEqual(512 * 1024)
    expect(incoming.readableEnded).toBe(false)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.byteLength).toBe(4 * 1024 * 1024)
    expect(bytes[0]).toBe(120)
    expect(bytes.at(-1)).toBe(120)
    expect(request.abort).not.toHaveBeenCalled()
  })

  it('aborts the native request when the caller cancels an unread response', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/stream')
    const request = await nextRequest()
    request.respond()
    const response = await pending
    await response.body?.cancel('caller no longer needs response')
    expect(request.abort).toHaveBeenCalledOnce()
    expect(() =>
      request.emit('error', new Error('Synthetic late cancellation error'))
    ).not.toThrow()
  })

  it('aborts an active native request before response headers', async () => {
    await configureProxy()
    const controller = new AbortController()
    const pending = electronHttpClient.fetch('https://origin.example/slow', {
      signal: controller.signal
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const request = await nextRequest()
    controller.abort()
    await rejection
    expect(request.abort).toHaveBeenCalledOnce()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('errors the response body when its caller aborts after receiving headers', async () => {
    await configureProxy()
    const controller = new AbortController()
    const pending = electronHttpClient.fetch('https://origin.example/slow', {
      signal: controller.signal
    })
    const request = await nextRequest()
    request.respond()
    const response = await pending
    const reading = response.text()
    const rejection = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(request.abort).toHaveBeenCalledOnce()
  })

  it.each([null, 'synthetic-abort-reason', { fixture: 'synthetic-abort-reason' }])(
    'preserves the native stream abort error after headers for reason %j',
    async (reason) => {
      await configureProxy()
      const controller = new AbortController()
      const pending = electronHttpClient.fetch('https://origin.example/slow', {
        signal: controller.signal
      })
      const request = await nextRequest()
      request.respond()
      const response = await pending
      const reading = response.text()
      const rejection = reading.catch((error: unknown) => error)
      controller.abort(reason)
      const error = await rejection
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.constructor.name).toBe('AbortError')
      }
      expect(error).toMatchObject({
        name: 'AbortError',
        message: 'The operation was aborted',
        code: 'ABORT_ERR'
      })
      expect(request.abort).toHaveBeenCalledOnce()
    }
  )

  it('rejects a native request error before headers without a direct fallback', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path')
    const rejection = expect(pending).rejects.toThrow('Synthetic network error')
    const request = await nextRequest()
    request.emit('error', new Error('Synthetic network error'))
    await rejection
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('propagates a native response stream error to an active body reader', async () => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/stream')
    const request = await nextRequest()
    const incoming = request.respond()
    const response = await pending
    const reading = response.text()
    const rejection = expect(reading).rejects.toThrow('Synthetic response stream error')
    incoming.destroy(new Error('Synthetic response stream error'))
    await rejection
  })

  it.each([
    ['HEAD', 200],
    ['GET', 204],
    ['GET', 205],
    ['GET', 304]
  ])('returns a null response body for %s %d', async (method, status) => {
    await configureProxy()
    const pending = electronHttpClient.fetch('https://origin.example/path', { method })
    const request = await nextRequest()
    request.respond(status).finish()
    const response = await pending
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })

  it('writes exact upload bytes through held native callbacks without disabling replay', async () => {
    await configureProxy()
    let produced = 0
    netRequestMock.mockImplementation((options) => {
      const request = new NativeHttpRequest(options)
      request.holdWrites = true
      requests.push(request)
      return request
    })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++
        controller.enqueue(new Uint8Array(32 * 1024).fill(produced))
        if (produced === 64) {
          controller.close()
        }
      }
    })
    const controller = new AbortController()
    const init = {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal
    } satisfies RequestInit & { duplex: 'half' }
    const pending = electronHttpClient.fetch('https://origin.example/upload', init)
    const settled = pending.catch(() => undefined)
    let request: NativeHttpRequest | undefined
    try {
      request = await nextRequest()
      const active = request
      await vi.waitFor(() => expect(active.chunks).toHaveLength(1))
      expect(request.writableFinished).toBe(false)
      expect(request.chunkedEncoding).toBe(false)
      request.flushWrites()
      await vi.waitFor(() => expect(active.writableFinished).toBe(true))
      expect(produced).toBe(64)
      const expected = Buffer.concat(
        Array.from({ length: 64 }, (_, index) => Buffer.alloc(32 * 1024, index + 1))
      )
      expect(Buffer.concat(request.chunks).equals(expected)).toBe(true)
      request.respond().finish()
      await (await pending).text()
    } finally {
      controller.abort()
      request?.flushWrites()
      await settled
    }
  })

  it.each([
    { label: 'default', reason: undefined },
    { label: 'Error', reason: new Error('Synthetic caller abort') },
    { label: 'null', reason: null }
  ])('preserves native upload cancellation for a caller $label abort', async ({ reason }) => {
    await configureProxy()
    const cancelled = vi.fn()
    netRequestMock.mockImplementation((options) => {
      const request = new NativeHttpRequest(options)
      request.holdWrites = true
      requests.push(request)
      return request
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024))
      },
      cancel: cancelled
    })
    const controller = new AbortController()
    const init = {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal
    } satisfies RequestInit & { duplex: 'half' }
    const pending = electronHttpClient.fetch('https://origin.example/upload', init)
    const outcome = pending.then(
      () => ({ resolved: true, error: undefined }),
      (error: unknown) => ({ resolved: false, error })
    )
    let request: NativeHttpRequest | undefined
    try {
      request = await nextRequest()
      const active = request
      await vi.waitFor(() => expect(active.chunks).toHaveLength(1))
      controller.abort(reason)
      request.flushWrites()
      const result = await outcome
      expect(result.resolved).toBe(false)
      if (reason === null) {
        expect(result.error).toBeInstanceOf(DOMException)
        expect(result.error).toMatchObject({
          name: 'AbortError',
          message: 'The operation was aborted.'
        })
      } else {
        expect(result.error).toBe(controller.signal.reason)
      }
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
      const cancellation: unknown = cancelled.mock.calls[0]?.[0]
      expect(cancellation).toBeInstanceOf(Error)
      expect(cancellation).toMatchObject({
        name: 'AbortError',
        message: 'The operation was aborted',
        code: 'ABORT_ERR'
      })
      if (!(cancellation instanceof Error)) {
        throw new Error('Expected native upload cancellation error')
      }
      expect(cancellation.constructor.name).toBe('AbortError')
      expect(cancellation).not.toBe(controller.signal.reason)
      expect(request.writableFinished).toBe(false)
      expect(request.responses).toHaveLength(0)
      expect(request.abort).toHaveBeenCalledOnce()
    } finally {
      controller.abort()
      request?.flushWrites()
      await outcome
    }
  })

  it('rejects a failed streaming request source and aborts the native request', async () => {
    await configureProxy()
    let failUpload = (): void => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        failUpload = () => controller.error(new Error('Synthetic upload source error'))
      }
    })
    const init = { method: 'POST', body, duplex: 'half' } satisfies RequestInit & { duplex: 'half' }
    const pending = electronHttpClient.fetch('https://origin.example/upload', init)
    const rejection = expect(pending).rejects.toThrow('Synthetic upload source error')
    const request = await nextRequest()
    failUpload()
    await rejection
    expect(request.abort).toHaveBeenCalledOnce()
  })
})
