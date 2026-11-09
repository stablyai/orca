import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

class FakeClientRequest extends EventEmitter {
  readonly headers = new Map<string, string>()
  ended = false
  destroyed = false
  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }
  end(): void {
    this.ended = true
  }
  destroy(): void {
    this.destroyed = true
    this.emit('error', new Error('socket hang up'))
  }
}

const requests = vi.hoisted(() => {
  const made: { url: string; request: unknown }[] = []
  return { made }
})

vi.mock('node:https', () => ({
  request: (url: string) => {
    const request = new FakeClientRequest()
    requests.made.push({ url, request })
    return request
  }
}))

const { openNodeSpeechDownloadRequest } = await import('./node-speech-download-request')

function lastRequest(): FakeClientRequest {
  const made = requests.made.at(-1)?.request
  if (!(made instanceof FakeClientRequest)) {
    throw new Error('no request made')
  }
  return made
}

function incoming(statusCode: number, headers: Record<string, string> = {}) {
  return Object.assign(new PassThrough(), { statusCode, headers })
}

describe('openNodeSpeechDownloadRequest', () => {
  it('reports a 3xx with a location as a redirect and drains it', () => {
    const handle = openNodeSpeechDownloadRequest('https://models.example/a.tar.bz2')
    const listeners = { error: vi.fn(), response: vi.fn(), redirect: vi.fn() }
    handle.listen(listeners)
    handle.setHeader('Range', 'bytes=10-')
    handle.end()
    const request = lastRequest()
    const redirect = incoming(302, { location: 'https://cdn.example/a.tar.bz2' })
    const resume = vi.spyOn(redirect, 'resume')
    request.emit('response', redirect)

    expect(request.headers.get('Range')).toBe('bytes=10-')
    expect(request.ended).toBe(true)
    expect(listeners.redirect).toHaveBeenCalledWith(302, 'GET', 'https://cdn.example/a.tar.bz2')
    expect(resume).toHaveBeenCalled()
    expect(listeners.response).not.toHaveBeenCalled()
  })

  it('hands any other response to the download', () => {
    const handle = openNodeSpeechDownloadRequest('https://models.example/a.tar.bz2')
    const listeners = { error: vi.fn(), response: vi.fn(), redirect: vi.fn() }
    handle.listen(listeners)
    const ok = incoming(206, { 'content-range': 'bytes 10-19/20' })
    lastRequest().emit('response', ok)
    expect(listeners.response).toHaveBeenCalledWith(ok)
  })

  // Abort emits after detach; an unhandled ClientRequest error crashes orcad.
  it('swallows the error abort raises after the download detached', () => {
    const handle = openNodeSpeechDownloadRequest('https://models.example/a.tar.bz2')
    const listeners = { error: vi.fn(), response: vi.fn(), redirect: vi.fn() }
    const detach = handle.listen(listeners)
    detach()
    expect(() => handle.abort()).not.toThrow()
    expect(lastRequest().destroyed).toBe(true)
    expect(listeners.error).not.toHaveBeenCalled()
  })
})
