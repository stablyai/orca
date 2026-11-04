import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeRequest extends EventEmitter {
  readonly abort = vi.fn()
  readonly end = vi.fn()
}

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request } }))

import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'

let native: FakeRequest

beforeEach(() => {
  native = new FakeRequest()
  request.mockReset().mockReturnValue(native)
})

describe('fetchWithElectronManualRedirects', () => {
  it('answers a redirect with the 3xx and stops the request, without cookies', async () => {
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {})
    native.emit('redirect', 302, 'GET', 'https://avatars.example/u/1', {
      location: ['https://avatars.example/u/1']
    })
    const response = await pending

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://avatars.example/u/1')
    expect(native.abort).toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: 'manual', credentials: 'omit', method: 'GET' })
    )
  })

  it('streams the final response body', async () => {
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {})
    native.emit(
      'response',
      Object.assign(Readable.from([Buffer.from('png')]), {
        statusCode: 200,
        headers: { 'content-type': 'image/png' }
      })
    )
    const response = await pending

    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('png')
  })

  it('keeps a raw relative Location for the caller to resolve', async () => {
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {})
    native.emit('redirect', 302, 'GET', 'https://github.com/u/3', { location: ['/u/3'] })

    expect((await pending).headers.get('location')).toBe('/u/3')
  })

  it('answers a bodyless status without throwing', async () => {
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {})
    const empty = Object.assign(new Readable({ read() {} }), { statusCode: 204, headers: {} })
    native.emit('response', empty)

    expect((await pending).status).toBe(204)
    expect(empty.destroyed).toBe(true)
    expect(native.abort).toHaveBeenCalled()
  })

  it('rejects at once for a deadline that already passed', async () => {
    const reason = new Error('deadline')
    await expect(
      fetchWithElectronManualRedirects('https://github.com/o.png', {
        signal: AbortSignal.abort(reason)
      })
    ).rejects.toBe(reason)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects and aborts a request still waiting at the deadline', async () => {
    const controller = new AbortController()
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {
      signal: controller.signal
    })
    controller.abort(new Error('deadline'))

    await expect(pending).rejects.toThrow('deadline')
    expect(native.abort).toHaveBeenCalled()
  })

  it('ends a stalled body at the deadline', async () => {
    const controller = new AbortController()
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {
      signal: controller.signal
    })
    const stalled = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} })
    native.emit('response', stalled)
    await pending
    controller.abort(new Error('deadline'))

    expect(stalled.destroyed).toBe(true)
  })

  it('stops the request when the caller cancels an oversized body', async () => {
    const pending = fetchWithElectronManualRedirects('https://github.com/o.png', {})
    const body = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} })
    native.emit('response', body)
    await (await pending).body?.cancel()

    expect(body.destroyed).toBe(true)
    expect(native.abort).toHaveBeenCalled()
  })
})
