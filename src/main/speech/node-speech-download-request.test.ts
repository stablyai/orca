import { EventEmitter } from 'node:events'
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

describe('openNodeSpeechDownloadRequest', () => {
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
