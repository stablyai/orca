import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
const { lookup, request } = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<{ address: string; family: number }[]>>(),
  request: vi.fn<(options: RequestOptions, callback: (incoming: unknown) => void) => EventEmitter>()
}))
import type { IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openPreviewNetworkResponse,
  readPreviewNetworkBytes,
  CHAT_PREVIEW_MAX_NETWORK_REQUESTS,
  CHAT_PREVIEW_MEDIA_TIMEOUT_MS,
  CHAT_PREVIEW_NETWORK_TIMEOUT_MS,
  streamPreviewNetworkResponse
} from './chat-address-preview-network'

vi.mock('node:dns/promises', () => ({ lookup }))
vi.mock('node:http', () => ({ request }))
vi.mock('node:https', () => ({ request: vi.fn() }))

const proxy = vi.hoisted(() => ({
  resolve: vi.fn(async () => 'DIRECT'),
  ready: vi.fn<() => boolean | Promise<boolean>>(() => true)
}))
vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy: proxy.resolve } } }))
vi.mock('../network/proxy-settings', () => ({
  getProxySessionApplicationReadiness: proxy.ready
}))

afterEach(() => vi.useRealTimers())
function respond(statusCode: number, headers: IncomingMessage['headers'], chunks: Buffer[] = []) {
  const response = Object.assign(Readable.from(chunks), {
    statusCode,
    headers,
    setTimeout: vi.fn()
  })
  vi.mocked(request).mockImplementationOnce((_options, callback) => {
    const outgoing = Object.assign(new EventEmitter(), {
      end: () => callback(response),
      destroy: () => {
        response.destroy()
        return outgoing
      }
    })
    return outgoing
  })
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  proxy.resolve.mockResolvedValue('DIRECT')
  proxy.ready.mockReturnValue(true)
  vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
})

const options = () => ({
  allowPrivateNetwork: false,
  signal: new AbortController().signal,
  budget: { requests: 0 }
})

describe('chat preview pinned HTTP transport', () => {
  it.each(['PROXY proxy.example:8080', 'SOCKS5 localhost:1080; DIRECT'])(
    'never opens a direct DNS lookup or socket when policy resolves to %s',
    async (policy) => {
      proxy.resolve.mockResolvedValue(policy)
      await expect(
        openPreviewNetworkResponse(new URL('http://files.example/file'), options())
      ).rejects.toThrow('proxy')
      expect(lookup).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )

  it.each([false, Promise.resolve(true)])(
    'fails closed while proxy policy is failed or pending',
    async (readiness) => {
      proxy.ready.mockReturnValue(readiness)
      await expect(
        openPreviewNetworkResponse(new URL('http://files.example/file'), options())
      ).rejects.toThrow('policy')
      expect(proxy.resolve).not.toHaveBeenCalled()
      expect(lookup).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('checks policy again after asynchronous DNS before connecting', async () => {
    vi.mocked(lookup).mockImplementationOnce(async () => {
      proxy.resolve.mockResolvedValue('PROXY proxy.example:8080')
      return [{ address: '1.1.1.1', family: 4 }]
    })
    await expect(
      openPreviewNetworkResponse(new URL('http://files.example/file'), options())
    ).rejects.toThrow('proxy')
    expect(request).not.toHaveBeenCalled()
  })
  it('connects to the validated numeric address with original Host and no ambient credentials', async () => {
    respond(200, { 'content-type': 'text/plain' }, [Buffer.from('hello')])
    const result = await openPreviewNetworkResponse(
      new URL('http://files.example/no-extension?token=public'),
      options()
    )
    const requestOptions = vi.mocked(request).mock.calls[0][0]
    expect(requestOptions.hostname).toBe('1.1.1.1')
    expect(requestOptions.agent).toBe(false)
    expect(requestOptions.path).toBe('/no-extension?token=public')
    expect(requestOptions.headers).toEqual({
      Host: 'files.example',
      Accept: '*/*',
      'Accept-Encoding': 'identity'
    })
    expect(requestOptions.auth).toBeUndefined()
    expect(await readPreviewNetworkBytes(result, 10)).toEqual(Buffer.from('hello'))
  })

  it('blocks a public redirect to private IP before the second socket opens', async () => {
    respond(302, { location: 'http://127.0.0.1/admin' })
    await expect(
      openPreviewNetworkResponse(new URL('http://files.example/file'), options())
    ).rejects.toThrow('permission')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['file:///etc/passwd', 'http://user:secret@files.example/private'])(
    'rejects redirect to %s even after private consent',
    async (location) => {
      respond(302, { location })
      await expect(
        openPreviewNetworkResponse(new URL('http://files.example/file'), {
          ...options(),
          allowPrivateNetwork: true
        })
      ).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it('revalidates DNS on every redirect rather than reusing the public result', async () => {
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    respond(302, { location: '/rebound' })
    await expect(
      openPreviewNetworkResponse(new URL('http://files.example/file'), options())
    ).rejects.toThrow('permission')
    expect(request).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('bounds an ignored Range prefix and destroys the unread response', async () => {
    const incoming = respond(200, {}, [Buffer.alloc(8192, 65), Buffer.alloc(8192, 66)])
    const result = await openPreviewNetworkResponse(new URL('http://files.example/file'), {
      ...options(),
      range: 'bytes=0-31'
    })
    expect(await readPreviewNetworkBytes(result, 32, true)).toEqual(Buffer.alloc(32, 65))
    expect(incoming.destroyed).toBe(true)
  })

  it('refuses an oversized body even when the server omits Content-Length', async () => {
    const incoming = respond(200, {}, [Buffer.alloc(65)])
    const result = await openPreviewNetworkResponse(new URL('http://files.example/file'), options())
    await expect(readPreviewNetworkBytes(result, 64)).rejects.toThrow('size limit')
    expect(incoming.destroyed).toBe(true)
  })

  it('caps both redirects and the lifetime request count', async () => {
    for (let index = 0; index < 5; index++) {
      respond(302, { location: '/again' })
    }
    await expect(
      openPreviewNetworkResponse(new URL('http://files.example/file'), options())
    ).rejects.toThrow('redirect limit')
    expect(request).toHaveBeenCalledTimes(5)
    const exhausted = { ...options(), budget: { requests: CHAT_PREVIEW_MAX_NETWORK_REQUESTS } }
    await expect(
      openPreviewNetworkResponse(new URL('http://files.example/file'), exhausted)
    ).rejects.toThrow('request limit')
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('does not expire a media body at the header deadline or the former lifetime deadline', async () => {
    vi.useFakeTimers()
    const incoming = respond(200, {}, [Buffer.from('media')])
    const result = await openPreviewNetworkResponse(new URL('http://files.example/video'), {
      ...options(),
      media: true
    })
    await vi.advanceTimersByTimeAsync(
      CHAT_PREVIEW_NETWORK_TIMEOUT_MS + CHAT_PREVIEW_MEDIA_TIMEOUT_MS
    )
    expect(incoming.destroyed).toBe(false)
    expect(await readPreviewNetworkBytes(result, 32)).toEqual(Buffer.from('media'))
  })

  it('enables socket idle timeout only while the media reader is waiting for data', async () => {
    const incoming = respond(200, {}, [Buffer.from('first'), Buffer.from('second')])
    const result = await openPreviewNetworkResponse(new URL('http://files.example/video'), {
      ...options(),
      media: true
    })
    const onClose = vi.fn()
    const reader = streamPreviewNetworkResponse(result, options().signal, onClose).getReader()
    expect((await reader.read()).value).toEqual(Buffer.from('first'))
    await vi.waitFor(() => expect(incoming.setTimeout).toHaveBeenLastCalledWith(0))
    expect(incoming.setTimeout).toHaveBeenCalledWith(CHAT_PREVIEW_MEDIA_TIMEOUT_MS)
    await reader.cancel()
    expect(incoming.destroyed).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('fails an idle media socket and releases its stream', async () => {
    const incoming = respond(200, {})
    const result = await openPreviewNetworkResponse(new URL('http://files.example/video'), {
      ...options(),
      media: true
    })
    const onClose = vi.fn()
    const reader = streamPreviewNetworkResponse(result, options().signal, onClose).getReader()
    incoming.emit('timeout')
    await expect(reader.read()).rejects.toThrow('timed out')
    expect(incoming.destroyed).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
