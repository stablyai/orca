import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrcaBridgePageTransport,
  readOrcaBridgePageChannel,
  type OrcaBridgePageChannel
} from './orca-bridge-page-channel'
import { createShellPageClient } from './page-bootstrap'
import { INIT } from './bridge-page-client-test-harness'

function installChannel(channel: unknown): void {
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
}

function createChannel(): OrcaBridgePageChannel {
  return { postMessage: vi.fn(), onmessage: null }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'orcaBridge')
  vi.restoreAllMocks()
})

describe('the page channel the shell installs', () => {
  it('is absent in a browser, which is a page the bundle still has to open', () => {
    expect(readOrcaBridgePageChannel()).toBeNull()
  })

  it('refuses a global of another shape rather than posting into it', () => {
    installChannel({ postMessage: 'not a function', onmessage: null })
    expect(readOrcaBridgePageChannel()).toBeNull()
  })

  it('reads the installed object itself, so the page posts through the real sink', () => {
    const channel = createChannel()
    installChannel(channel)
    expect(readOrcaBridgePageChannel()).toBe(channel)
  })
})

describe('the page channel as a client transport', () => {
  it('posts what the client sends', () => {
    const channel = createChannel()
    createOrcaBridgePageTransport(channel).send('{"v":1}')
    expect(channel.postMessage).toHaveBeenCalledWith('{"v":1}')
  })

  it('hands the client the frame off the event, and gives the slot back', () => {
    const channel = createChannel()
    const handler = vi.fn()
    const release = createOrcaBridgePageTransport(channel).onMessage(handler)
    channel.onmessage?.({ data: '{"v":1,"type":"init"}' })
    expect(handler).toHaveBeenCalledWith('{"v":1,"type":"init"}')
    release()
    expect(channel.onmessage).toBeNull()
  })
})

describe('replacement native channels', () => {
  it('uses the replacement for the next attempt without replaying the failed request', async () => {
    const first = createChannel()
    const next = createChannel()
    installChannel(first)
    const client = createShellPageClient()
    if (client === null) {
      throw new Error('missing shell client')
    }
    first.onmessage?.({ data: JSON.stringify(INIT) })
    const retiredCallback = first.onmessage
    first.postMessage = vi.fn(() => {
      throw new Error('retired port')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(client.sendRequest('worktree.ps')).rejects.toThrow(/post/)
    installChannel(next)
    const request = client.sendRequest('worktree.ps').catch((error: unknown) => {
      throw error
    })
    void request.catch(() => undefined)
    expect(next.postMessage).toHaveBeenCalledTimes(1)
    expect(first.postMessage).toHaveBeenCalledTimes(1)
    expect(first.onmessage).toBeNull()
    retiredCallback?.({ data: JSON.stringify({ ...INIT, sessionId: 'retired' }) })
    expect(client.getShellSession()?.sessionId).toBe(INIT.sessionId)
    next.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'reply',
        id: '2'.padStart(22, '0'),
        payload: { id: 'wire', ok: true, result: 'recovered', _meta: { runtimeId: 'host' } }
      })
    })
    expect((await request).ok).toBe(true)
    client.close()
    expect(next.onmessage).toBeNull()
    warn.mockRestore()
  })

  it('does not post into a retired channel when the current global is absent', () => {
    const first = createChannel()
    installChannel(first)
    const transport = createOrcaBridgePageTransport(first, readOrcaBridgePageChannel)
    const handler = vi.fn()
    const release = transport.onMessage(handler)
    Reflect.deleteProperty(globalThis, 'orcaBridge')
    expect(() => transport.send('request')).toThrow(/unavailable/)
    expect(first.postMessage).not.toHaveBeenCalled()
    expect(first.onmessage).toBeNull()
    release()
  })

  it('does not remove another listener while releasing its own binding', () => {
    const first = createChannel()
    const transport = createOrcaBridgePageTransport(first)
    const release = transport.onMessage(vi.fn())
    const replacement = vi.fn()
    first.onmessage = replacement
    release()
    expect(first.onmessage).toBe(replacement)
  })
})
